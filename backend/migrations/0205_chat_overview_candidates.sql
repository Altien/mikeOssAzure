-- Migration date: 2026-10-29
-- Avoid evaluating chat permissions for unrelated tenants on GET /chat.
-- The canonical role function still authorizes every returned row.
--
-- Dev (upstream 20261029_01_chat_overview_candidates.sql): Dev keeps text
-- user ids on chats/projects, so creator lookups compare p_user_id as text
-- (as chat_access_role does); only org_members is keyed by the uuid actor.

create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  updated_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  candidate record;
  skipped integer := 0;
  returned integer := 0;
  row_limit integer := case when p_limit is null then null else greatest(1,least(p_limit,100)) end;
begin
  for candidate in
  -- Narrow with indexed identity/grant lookups before invoking the canonical
  -- permission function. Walking every tenant's chats in updated_at order
  -- makes an inactive user's first page cost grow with unrelated traffic.
  -- These candidates are an over-approximation, never an access decision.
  with actor as materialized (
    select case
      when p_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then p_user_id::uuid
    end as id
  ), member_orgs as materialized (
    select m.org_id from public.org_members m
    join actor a on a.id = m.user_id
  ), candidate_projects as materialized (
    select p.id from public.projects p where p.user_id = p_user_id
    union
    select g.project_id from public.project_access_grants g
      where coalesce(p_user_email, '') <> '' and g.email = lower(p_user_email)
    union
    select p.id from public.projects p join member_orgs m on m.org_id = p.org_id
  ), candidate_ids as materialized (
    select c.id from public.chats c where c.user_id = p_user_id
    union
    select g.chat_id from public.chat_access_grants g
      where coalesce(p_user_email, '') <> '' and g.email = lower(p_user_email)
    union
    select c.id from public.chats c join member_orgs m on m.org_id = c.org_id
    union
    select c.id from public.chats c
      join candidate_projects p on p.id = c.project_id
  )
  select c.*, p.name as project_name
  from candidate_ids ids
  join public.chats c on c.id = ids.id
  left join public.projects p on p.id = c.project_id
  where public.workspace_matches(p_workspace, c.org_id)
    and (
      p_before_updated_at is null
      or c.updated_at < p_before_updated_at
      or (c.updated_at = p_before_updated_at and c.id > p_before_id)
    )
  order by c.updated_at desc, c.id asc
  loop
    -- Evaluate the authoritative verdict once, and stop after a page. In
    -- particular, do not materialize role checks for all of an active user's
    -- old chats just to return their newest fifty.
    access_role := public.chat_access_role(
      candidate.id,candidate.user_id,candidate.project_id,candidate.org_id,p_user_id,p_user_email
    );
    if access_role is null then continue; end if;
    if skipped < greatest(coalesce(p_offset,0),0) then
      skipped := skipped + 1;
      continue;
    end if;
    id := candidate.id;
    project_id := candidate.project_id;
    user_id := candidate.user_id::text;
    title := candidate.title;
    model := candidate.model;
    created_at := candidate.created_at;
    updated_at := candidate.updated_at;
    project_name := candidate.project_name;
    is_owner := coalesce(candidate.user_id::text = p_user_id,false);
    return next;
    returned := returned + 1;
    if row_limit is not null and returned >= row_limit then exit; end if;
  end loop;
end;
$$;
