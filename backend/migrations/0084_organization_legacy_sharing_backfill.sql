-- Copy the old personal sharing representation into role-aware grants.
-- Keep the legacy columns until every old reader is retired and verified.
begin;
create table if not exists public.organization_backfill_markers (
  key text primary key,
  completed_at timestamptz not null default now()
);
revoke all on public.organization_backfill_markers from public, web_anon, authenticated;
grant select, insert on public.organization_backfill_markers to service_role;

do $migration$
begin
  perform pg_advisory_xact_lock(hashtextextended('organization_legacy_sharing_backfill', 0));
  if exists (select 1 from public.organization_backfill_markers where key='legacy_sharing_v1') then
    return;
  end if;

  insert into public.project_access_grants(project_id,email,role,created_by)
  select distinct project.id, lower(trim(recipient.email)), 'editor', profile.user_id
  from public.projects project
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(project.shared_with)='array' then project.shared_with else '[]'::jsonb end
  ) recipient(email)
  left join public.user_profiles profile on profile.user_id::text=project.user_id
  where project.org_id is null and trim(recipient.email)<>'' and position('@' in recipient.email)>0
  on conflict (project_id,email) do nothing;

  insert into public.tabular_review_access_grants(tabular_review_id,email,role,created_by)
  select distinct review.id, lower(trim(recipient.email)), 'editor', profile.user_id
  from public.tabular_reviews review
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(review.shared_with)='array' then review.shared_with else '[]'::jsonb end
  ) recipient(email)
  left join public.user_profiles profile on profile.user_id::text=review.user_id
  where review.project_id is null and review.org_id is null
    and trim(recipient.email)<>'' and position('@' in recipient.email)>0
  on conflict (tabular_review_id,email) do nothing;

  update public.workflow_shares
  set role=case when allow_edit then 'editor' else 'viewer' end;

  insert into public.organization_backfill_markers(key) values('legacy_sharing_v1');
end;
$migration$;
commit;
notify pgrst, 'reload schema';
