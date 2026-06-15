-- 0015_workflows_overview_rpc.sql
--
-- Workflows overview read model. Returns owned + shared (non-system)
-- workflows in one call, resolving the sharer's display name from
-- user_profiles (consumed by `GET /workflows` via
-- db.rpc("get_workflows_overview") — see backend/src/routes/workflows.ts).
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260613_05_workflows_overview_rpc.sql` (commit
-- 9a1277ba99cbd7dfae77e5b882e5cef8521fca2f). Plain SQL, no Supabase-auth
-- coupling.
--
-- IMPORTANT (dev divergence — sync-log a2368a7/9a1277b): `shared_by_name`
-- comes from `user_profiles.display_name`, NOT from a Supabase
-- `auth.admin.getUserById` lookup. Dev has no Supabase auth admin API; this
-- RPC preserves dev's standing "no auth.admin" divergence (see the
-- resolveWorkflowAccess comment in backend/src/routes/workflows.ts).
-- workflows.user_id and workflow_shares.shared_by_user_id are `text`;
-- user_profiles.user_id is `uuid` (cast for the join).
--
-- Idempotent (create or replace).

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
  practice text,
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
      w.*,
      true as allow_edit,
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id = p_user_id
      and w.is_system = false
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.*,
      ws.allow_edit,
      false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id
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
    vw.practice,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;
