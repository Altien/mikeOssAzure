-- Application onboarding for Entra, local and Supabase users. Profile rows are
-- created by authenticated middleware, not by a Supabase auth.users trigger.
alter table public.user_profiles
  add column if not exists jurisdiction text,
  add column if not exists practice_setting text,
  add column if not exists professional_title text,
  add column if not exists practice_areas text[] not null default '{}'::text[];

alter table public.user_profiles drop constraint if exists user_profiles_practice_setting_check;
alter table public.user_profiles add constraint user_profiles_practice_setting_check
  check (practice_setting is null or practice_setting in ('private_practice', 'in_house', 'not_practising'));
alter table public.user_profiles drop constraint if exists user_profiles_professional_title_check;
alter table public.user_profiles add constraint user_profiles_professional_title_check
  check (professional_title is null or professional_title in
    ('Partner', 'Senior Associate', 'Associate', 'Law Clerk', 'Counsel', 'General Counsel', 'Legal Counsel', 'Other'));

-- Mark only the rows that existed when version tracking was introduced. A
-- replay must not turn a newer, unfinished account into a legacy account.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles'
      and column_name = 'onboarding_version'
  ) then
    alter table public.user_profiles add column onboarding_version integer;
    update public.user_profiles set onboarding_version = 0;
  end if;
end $$;

alter table public.user_profiles
  drop constraint if exists user_profiles_onboarding_version_check;
alter table public.user_profiles
  add constraint user_profiles_onboarding_version_check
  check (onboarding_version is null or onboarding_version in (0, 1));
