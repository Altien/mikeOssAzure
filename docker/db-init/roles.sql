-- Runs once on first DB init (after the supabase/postgres image creates its
-- base roles). Guarantees GoTrue and PostgREST can log in with POSTGRES_PASSWORD.
-- ponytail: only forces the two login passwords; everything else the image sets up.
-- Must NOT live under supabase/ — the Supabase CLI seeds supabase/roles.sql on
-- `supabase start` as a non-superuser, where altering supabase_auth_admin is
-- rejected as a reserved role (42501). Here it runs as the init superuser.
do $$
begin
  if exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    alter role supabase_auth_admin with login password 'postgres';
  end if;
  if exists (select from pg_roles where rolname = 'authenticator') then
    alter role authenticator with login password 'postgres';
  end if;
end $$;
