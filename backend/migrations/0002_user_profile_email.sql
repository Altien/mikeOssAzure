-- Adds an email column to user_profiles so the backend can resolve
-- user_id ↔ email without going through Supabase Auth's admin API.
--
-- Why: routes like /projects/:id/people, /tabular-review/:id/people, and
-- the workflow share lookup previously walked auth.admin.listUsers({})
-- — that API only exists when AUTH_PROVIDER=supabase.  Under
-- AUTH_PROVIDER=local|entra those calls 500.
--
-- The middleware's upsertUserProfile() now writes user_id + email on
-- every authenticated request, so the column populates organically as
-- users log in.  Existing supabase-mode rows back-fill on next login.

alter table public.user_profiles
  add column if not exists email text;

create index if not exists idx_user_profiles_email
  on public.user_profiles(lower(email));
