-- 0040_workflow_metadata.sql
--
-- Custom workflow metadata fields (`language`, `jurisdictions`) and the
-- workflow overview read model that returns them. System workflows are code
-- (`backend/src/lib/systemWorkflows.ts`, served by the route), not rows.
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260625_01_workflow_metadata.sql` (OSS-6 step A,
-- upstream @ 204d2d53). Idempotent.
--
-- Upstream divergences (OSS-6 spec §3.1):
--   * `drop column if exists is_system` is NOT applied here. Dev's current
--     routes/workflows.ts still filters on it; the column is dropped in a
--     later migration (0043) once the route stops reading it (§4.3: never
--     drop a column in the migration that introduces its replacement).
--   * `drop column if exists author, category` omitted: dev never had them.
--   * The RPC keeps text-vs-uuid casts for the user_profiles join
--     (workflows.user_id / workflow_shares.shared_by_user_id are `text`,
--     user_profiles.user_id is `uuid`) — dev's no-auth.admin rule (a2368a7).

alter table public.workflows
  add column if not exists language text default 'English',
  add column if not exists jurisdictions text[] default array['General']::text[];

alter table public.workflows
  alter column language set default 'English',
  alter column practice set default 'General Transactions',
  alter column jurisdictions set default array['General']::text[];

update public.workflows
set
  language = coalesce(nullif(trim(language), ''), 'English'),
  practice = coalesce(nullif(trim(practice), ''), 'General Transactions'),
  jurisdictions = coalesce(jurisdictions, array['General']::text[])
where user_id is not null;

-- The return type changes (adds language/jurisdictions), so `create or
-- replace` alone is rejected by Postgres; drop first.
drop function if exists public.get_workflows_overview(text, text, text);

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id,
      w.user_id::text as user_id,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      true as allow_edit,
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id,
      w.user_id::text as user_id,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      ws.allow_edit,
      false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
  )
  select
    vw.id,
    vw.user_id,
    vw.title,
    vw.type,
    vw.prompt_md,
    vw.columns_config,
    vw.language,
    vw.practice,
    vw.jurisdictions,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;
