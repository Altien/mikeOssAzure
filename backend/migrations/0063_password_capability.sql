-- Record a password only after a successful authenticated provider operation.
-- This private Azure database has no auth.users schema, so no identity-metadata
-- or SQL backfill can prove the presence of an existing password.
alter table public.user_profiles
  add column if not exists password_set_at timestamptz;
