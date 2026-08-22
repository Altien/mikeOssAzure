alter table public.tabular_reviews
  add column if not exists active_generation_id uuid,
  add column if not exists generation_lease_expires_at timestamptz;

alter table public.tabular_cells
  add column if not exists generation_id uuid;

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
  select *
    into current_review
    from public.tabular_reviews
   where id = target_review_id
   for update;

  if not found then
    return 'not_found';
  end if;

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

  return 'started';
end;
$$;

create or replace function public.renew_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set generation_lease_expires_at = now()
       + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

create or replace function public.finish_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set active_generation_id = null,
         generation_lease_expires_at = null
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.renew_tabular_review_generation(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.finish_tabular_review_generation(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  to service_role;
grant execute on function public.renew_tabular_review_generation(uuid, uuid, integer)
  to service_role;
grant execute on function public.finish_tabular_review_generation(uuid, uuid)
  to service_role;
