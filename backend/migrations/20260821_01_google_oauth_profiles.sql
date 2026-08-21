-- Support OAuth-created profiles and the post-signup onboarding flow.
-- Existing accounts are marked complete so introducing onboarding does not
-- interrupt them.

alter table public.user_profiles
  add column if not exists jurisdiction text,
  add column if not exists practice_setting text,
  add column if not exists professional_title text,
  add column if not exists practice_areas text[] not null default '{}'::text[],
  add column if not exists onboarding_completed_at timestamptz;

alter table public.user_profiles
  drop constraint if exists user_profiles_practice_setting_check;

alter table public.user_profiles
  add constraint user_profiles_practice_setting_check
  check (
    practice_setting is null
    or practice_setting in ('private_practice', 'in_house', 'not_practising')
  );

alter table public.user_profiles
  drop constraint if exists user_profiles_professional_title_check;

alter table public.user_profiles
  add constraint user_profiles_professional_title_check
  check (
    professional_title is null
    or professional_title in (
      'Partner',
      'Senior Associate',
      'Associate',
      'Law Clerk',
      'Counsel',
      'General Counsel',
      'Legal Counsel',
      'Other'
    )
  );

update public.user_profiles
set onboarding_completed_at = now()
where onboarding_completed_at is null;

-- Email/password signup collects profile details during onboarding. Google
-- may supply full_name/name immediately, so preserve it as the initial value.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (
    user_id,
    email,
    display_name,
    organisation
  )
  values (
    new.id,
    lower(new.email),
    nullif(left(btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), 200), ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'organisation', '')), 200), '')
  )
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = coalesce(
          nullif(btrim(user_profiles.display_name), ''),
          excluded.display_name
        ),
        organisation = coalesce(
          nullif(btrim(user_profiles.organisation), ''),
          excluded.organisation
        ),
        updated_at = now();
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;
