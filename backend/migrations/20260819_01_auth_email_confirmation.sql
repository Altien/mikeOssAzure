-- Preserve profile fields while signup awaits email confirmation, and keep the
-- profile email mirror current after a confirmed email-address change.

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
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 200), ''),
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

create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_profiles
  set email = lower(new.email),
      updated_at = now()
  where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.handle_user_email_updated();
