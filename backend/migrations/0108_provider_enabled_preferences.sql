-- Upstream sync: 25779536e46f1407e18f44fd9d2863a7602bd5c4
-- Keep the legacy encrypted-row shape, but user-facing enablement is a
-- separate preference; a preference must never create a shadow credential.
begin;
alter table public.user_api_keys add column if not exists enabled boolean not null default true;
alter table public.user_profiles
  add column if not exists provider_enabled jsonb not null default '{}'::jsonb;
alter table public.user_profiles drop constraint if exists user_profiles_provider_enabled_check;
alter table public.user_profiles add constraint user_profiles_provider_enabled_check
  check (jsonb_typeof(provider_enabled) = 'object');

create or replace function public.set_user_provider_enabled(
  p_user_id text, p_provider text, p_enabled boolean
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare affected integer;
begin
  if p_user_id is null or p_user_id = '' or p_enabled is null or p_provider not in (
    'claude','gemini','openai','kimi','mistral','openrouter','vercel','opencode-go',
    'azure_openai','bedrock','azure','azure-foundry','vertex','xai','custom','courtlistener'
  ) then raise exception 'invalid_provider_preference'; end if;
  update public.user_profiles
     set provider_enabled = case when p_provider in ('azure','azure_openai')
           then coalesce(provider_enabled, '{}'::jsonb) || jsonb_build_object(
             'azure',p_enabled,'azure_openai',p_enabled)
           else jsonb_set(coalesce(provider_enabled, '{}'::jsonb),
             array[p_provider], to_jsonb(p_enabled), true) end,
         updated_at = now()
   where user_id = p_user_id;
  get diagnostics affected = row_count;
  return affected = 1;
end; $$;
revoke all on function public.set_user_provider_enabled(text,text,boolean)
  from public, web_anon, authenticated;
grant execute on function public.set_user_provider_enabled(text,text,boolean) to service_role;
commit;
notify pgrst, 'reload schema';
