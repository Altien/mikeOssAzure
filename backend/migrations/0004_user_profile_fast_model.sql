-- Adds a per-user "fast model" preference to user_profiles. Used for
-- lightweight LLM tasks (chat title generation today, room for more) so
-- the user can pick which provider/model gets called for those calls
-- rather than the backend hardcoding a Gemini default.
--
-- NULL means "no preference set" — the title-resolution chain in
-- userSettings.ts falls back through gemini > openai > claude > AOAI
-- default-deployment, same shape as before.

alter table public.user_profiles
  add column if not exists fast_model text;
