-- Dev forward adaptation of upstream ec33d99109a4bb9b86c08d469b2f030fb7488ae5 (source 47).
-- Canonical numbered history; native migration runner owns this file transaction.
-- Resource IDs remain UUID; resource owners and RPC user identities retain TEXT.
-- Private PostgREST grants and application account-erasure semantics apply.

drop function if exists public.get_project_summaries(text, text, integer, integer);
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
set search_path = public, pg_temp
as $
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    coalesce(p.user_id::text = p_user_id, false) as is_owner
  from public.projects p
  where public.project_access_role(
    p.id, p.user_id, p.org_id, p_user_id, p_user_email
  ) is not null
    and public.workspace_matches(p_workspace, p.org_id)
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Private PostgREST: these RPCs/triggers are backend service-role only.
do $privileges$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array['get_project_summaries']::text[])
  loop
    execute format('revoke all on function %s from public, web_anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end;
$privileges$;

notify pgrst, 'reload schema';
