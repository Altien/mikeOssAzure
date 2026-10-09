-- Dev numbered adaptation of upstream 48df0f40
-- (20261002_06_user_custom_instructions.sql): free-form custom instructions a
-- user writes in Settings > Personalisation, added to the system prompt of
-- assistant, project and Word chats. Idempotent; the column inherits the
-- existing user_profiles table privileges (no new grants, no RLS).
alter table public.user_profiles
  add column if not exists custom_instructions text not null default '';

alter table public.user_profiles
  drop constraint if exists user_profiles_custom_instructions_length;
alter table public.user_profiles
  add constraint user_profiles_custom_instructions_length
  check (char_length(custom_instructions) <= 8000);
