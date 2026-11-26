-- Migration date: 2026-11-01
-- ownerless_org_item_ids (the backend's list filters for organization
-- Owners) called project_is_ownerless / workflow_is_ownerless once per
-- private item, three subqueries each. The same conditions as anti-joins.
-- Upstream divergence (sync-log: 18132c24): Dev's projects.user_id and
-- workflows.user_id are text while org_members.user_id is uuid, so the
-- creator anti-join compares creator.user_id::text exactly as Dev's
-- project_is_ownerless / workflow_is_ownerless do (a uuid cast of the item
-- creator would fail on non-uuid local ids). search_path keeps pg_temp (0111).
create or replace function public.ownerless_org_item_ids(p_org_ids uuid[])
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public, pg_temp
as $$
  -- project_is_ownerless / workflow_is_ownerless, written as anti-joins so
  -- the planner evaluates them for the whole set at once instead of calling
  -- a function (three subqueries) per private item. Keep the conditions in
  -- step with those functions: not archived, creator no longer a member of
  -- the item's organization, and no 'owner' override.
  select 'project'::text, p.id
  from public.projects p
  where p.org_id = any(p_org_ids)
    and p.visibility <> 'organization'
    and p.archived_at is null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p.org_id and creator.user_id::text = p.user_id
    )
    and not exists (
      select 1 from public.project_org_access_overrides o
      where o.project_id = p.id and o.role = 'owner'
    )
  union all
  select 'workflow'::text, w.id
  from public.workflows w
  where w.org_id = any(p_org_ids)
    and w.visibility <> 'organization'
    and w.archived_at is null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = w.org_id and creator.user_id::text = w.user_id
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides o
      where o.workflow_id = w.id and o.role = 'owner'
    );
$$;
