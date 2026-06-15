-- 0012_chats_overview_rpc.sql
--
-- Global assistant-chats overview read model. Returns the user's own chats
-- plus chats under projects they own, in one database call (consumed by
-- `GET /chat` via db.rpc("get_chats_overview") — see backend/src/routes/chat.ts).
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260613_01_chats_overview_rpc.sql` (commit
-- 9a1277ba99cbd7dfae77e5b882e5cef8521fca2f). The function is plain SQL with
-- no Supabase-auth coupling: it takes the user id as a `text` parameter
-- (matching dev's `chats.user_id`/`projects.user_id` text columns) rather
-- than calling `auth.uid()`. Authorization is the caller's responsibility —
-- the backend passes the authenticated Entra oid.
--
-- Idempotent (create or replace).

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id,
    c.title,
    c.created_at
  from public.chats c
  where c.user_id = p_user_id
     or exists (
      select 1
      from public.projects p
      where p.id = c.project_id
        and p.user_id = p_user_id
    )
  order by c.created_at desc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end;
$$;
