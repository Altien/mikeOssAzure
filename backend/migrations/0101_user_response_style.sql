-- Dev numbered adaptation of upstream d19fdc6d
-- (20261006_01_user_response_style.sql, first draft): response style
-- preferences from Settings > Personalisation — verbosity, headers and lists
-- (response_formatting) and tone. 'balanced' adds nothing to the prompt.
-- Idempotent; the columns inherit the existing user_profiles table privileges
-- (no new grants, no RLS).
alter table public.user_profiles
  add column if not exists response_verbosity text not null default 'balanced';
alter table public.user_profiles
  add column if not exists response_formatting text not null default 'balanced';
alter table public.user_profiles
  add column if not exists response_tone text not null default 'balanced';

alter table public.user_profiles
  drop constraint if exists user_profiles_response_verbosity_check;
alter table public.user_profiles
  add constraint user_profiles_response_verbosity_check
  check (response_verbosity in ('concise', 'balanced', 'detailed'));

alter table public.user_profiles
  drop constraint if exists user_profiles_response_formatting_check;
alter table public.user_profiles
  add constraint user_profiles_response_formatting_check
  check (response_formatting in ('balanced', 'less', 'more'));

alter table public.user_profiles
  drop constraint if exists user_profiles_response_tone_check;
alter table public.user_profiles
  add constraint user_profiles_response_tone_check
  check (response_tone in ('formal', 'balanced', 'plain'));
