-- Forward correction for source99 b4146ed976ed4f7bcd6516ce4da604c288f40bff.
--0122 split the global user key into Personal/workspace partial indexes.
-- Keep the original initialization and infer the existing Personal key.
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
  on conflict (user_id) where org_id is null do nothing;
  return new;
end;
$$;
revoke all on function public.initialize_new_user_memory() from public,web_anon,authenticated;
grant execute on function public.initialize_new_user_memory() to service_role;
notify pgrst,'reload schema';
