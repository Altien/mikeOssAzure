-- Persist whether Supabase has an email/password credential for an account.
-- Provider identities cannot reliably answer this for OAuth-created users.

alter table public.user_profiles
  add column if not exists password_set_at timestamptz;

-- Backfill existing credentials from the source of truth.
update public.user_profiles as profile
set password_set_at = now()
from auth.users as auth_user
where profile.user_id = auth_user.id
  and profile.password_set_at is null
  and auth_user.encrypted_password is not null
  and auth_user.encrypted_password::text <> '';

-- The frontend calls this after Supabase has accepted a password update. The
-- function independently verifies auth.users before recording the capability,
-- so the client cannot mark an account as password-enabled by assertion alone.
create or replace function public.sync_user_password_set(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  recorded_at timestamptz;
begin
  update public.user_profiles as profile
  set password_set_at = coalesce(profile.password_set_at, now()),
      updated_at = now()
  where profile.user_id = p_user_id
    and exists (
      select 1
      from auth.users as auth_user
      where auth_user.id = p_user_id
        and auth_user.encrypted_password is not null
        and auth_user.encrypted_password::text <> ''
    )
  returning profile.password_set_at into recorded_at;

  return recorded_at;
end;
$$;

revoke all on function public.sync_user_password_set(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_user_password_set(uuid)
  to service_role;
