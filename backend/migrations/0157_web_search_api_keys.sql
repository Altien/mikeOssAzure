-- Dev source177 candidate bbfca12939958a77bccc76bf4f7dc013e85d3187
-- Dated mapping: backend/migrations/20261020_02_web_search_api_keys.sql
-- Provisional order within source 2; reconcile actual176/177/178 numbering.
-- Native canonical runner owns the transaction; no parallel schema history.

-- Migration date: 2026-10-20
-- Tavily and DeepSeek API keys for Mike's own web search are saved like the
-- Brave Search key, per user or per organization. Existing key rows and private
-- grants are unchanged.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;
alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'kimi', 'azure_openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave', 'tavily', 'deepseek'));

alter table public.org_api_keys
  drop constraint if exists org_api_keys_provider_check;
alter table public.org_api_keys
  add constraint org_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'kimi', 'azure_openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave', 'tavily', 'deepseek'));

revoke all on public.user_profiles from public, web_anon, authenticated;
grant select,insert,update,delete on public.user_profiles to service_role;

notify pgrst, 'reload schema';
