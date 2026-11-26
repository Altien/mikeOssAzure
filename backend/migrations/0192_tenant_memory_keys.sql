-- Multi-tenant 013: an identity moving to a new tenant starts fresh memory.
-- A global user unique caused the new profile trigger to silently skip its
-- memory row, or settings upserts to collide with invisible source-tenant data.
--
-- Renumbered from 0125 when multi-tenant merged into main. Main's 0122 had
-- already replaced the global memory_files_user_unique with two partial keys:
-- memory_files_user_personal_unique (user_id) where org_id is null, and
-- memory_files_user_workspace_unique (user_id, org_id) where org_id is not
-- null. Only the Personal key can collide across tenants (an organization
-- belongs to one tenant), so only it becomes tenant-scoped.
drop index if exists public.memory_files_user_personal_unique;
create unique index if not exists memory_files_tenant_user_personal_unique
  on public.memory_files(tenant_id, user_id) where org_id is null;
-- project_id remains a globally unique parent UUID; its conflict target and
-- index do not change. Existing bodies, ownership and fences stay intact.
-- ensure_user_memory_file (0122) and delete_user_private_memories (0170) use
-- an untargeted ON CONFLICT DO NOTHING and need no change.

-- Main's 0175 body; only the conflict target gains tenant_id.
create or replace function public.initialize_new_user_memory()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.memory_files(scope, user_id, enabled)
  values ('user', new.user_id::text, not exists (
    select 1 from public.projects p where p.user_id = new.user_id::text
    union all select 1 from public.chats c where c.user_id = new.user_id::text
    union all select 1 from public.word_chats w where w.user_id = new.user_id::text
    union all select 1 from public.tabular_reviews r where r.user_id = new.user_id::text
  ))
  on conflict (tenant_id, user_id) where org_id is null do nothing;
  return new;
end;
$$;

revoke all on function public.initialize_new_user_memory(), public.delete_user_private_memories(text, uuid)
  from public, web_anon, authenticated;
grant execute on function public.initialize_new_user_memory(), public.delete_user_private_memories(text, uuid)
  to tenant_app, service_role;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 013: tenant RLS gaps: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
