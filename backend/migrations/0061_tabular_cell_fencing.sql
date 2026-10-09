-- Keep cell ownership in the same database transaction as a review lease.
-- A worker whose lease expired must not restart a cell after a new run starts.
create or replace function public.begin_tabular_review_generation(
  target_review_id uuid,
  expected_updated_at timestamptz,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_review public.tabular_reviews%rowtype;
begin
  select * into current_review
    from public.tabular_reviews
   where id = target_review_id
   for update;

  if not found then return 'not_found'; end if;
  if current_review.active_generation_id is not null
     and current_review.generation_lease_expires_at > now() then
    return 'running';
  end if;
  if current_review.updated_at is distinct from expected_updated_at then
    return 'stale';
  end if;

  update public.tabular_reviews
     set active_generation_id = target_generation_id,
         generation_lease_expires_at = now()
           + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id;

  -- Invalidate callbacks from an expired owner before the new owner reads
  -- its cell snapshot. Completed cells have no generation_id and stay done.
  update public.tabular_cells
     set status = 'pending', content = null, generation_id = null
   where review_id = target_review_id and generation_id is not null;

  return 'started';
end;
$$;

create or replace function public.claim_tabular_review_cell(
  target_review_id uuid,
  target_generation_id uuid,
  target_row_id uuid,
  target_document_id uuid,
  target_column_index integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lease_active boolean;
begin
  -- FOR SHARE serializes this claim with begin's FOR UPDATE on the review.
  select active_generation_id = target_generation_id
         and generation_lease_expires_at > now()
    into lease_active
    from public.tabular_reviews
   where id = target_review_id
   for share;
  if lease_active is distinct from true then return false; end if;

  update public.tabular_cells
     set status = 'generating', content = null,
         generation_id = target_generation_id
   where review_id = target_review_id
     and row_id = target_row_id
     and column_index = target_column_index;
  if not found then
    insert into public.tabular_cells (
      review_id, row_id, document_id, column_index, status, generation_id
    ) values (
      target_review_id, target_row_id, target_document_id,
      target_column_index, 'generating', target_generation_id
    );
  end if;
  return true;
end;
$$;

create or replace function public.clear_tabular_review_cells(
  target_review_id uuid,
  target_generation_id uuid,
  target_row_ids uuid[]
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lease_active boolean;
begin
  select active_generation_id = target_generation_id
         and generation_lease_expires_at > now()
    into lease_active
    from public.tabular_reviews
   where id = target_review_id
   for share;
  if lease_active is distinct from true then return false; end if;

  update public.tabular_cells
     set content = null, status = 'pending', generation_id = null
   where review_id = target_review_id and row_id = any(target_row_ids);
  return true;
end;
$$;

revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  from public, web_anon, authenticated;
revoke all on function public.claim_tabular_review_cell(uuid, uuid, uuid, uuid, integer)
  from public, web_anon, authenticated;
revoke all on function public.clear_tabular_review_cells(uuid, uuid, uuid[])
  from public, web_anon, authenticated;
grant execute on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  to service_role;
grant execute on function public.claim_tabular_review_cell(uuid, uuid, uuid, uuid, integer)
  to service_role;
grant execute on function public.clear_tabular_review_cells(uuid, uuid, uuid[])
  to service_role;
