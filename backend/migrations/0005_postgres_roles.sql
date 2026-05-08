-- Ensure the PostgREST role topology exists on this Postgres cluster.
--
-- The OSS-Supabase init script (scripts/local-stack/00-init-roles.sql)
-- creates these roles for local dev, but the Azure deploy never had a
-- corresponding step — the original Bicep assumed pg_admin owns
-- everything and never created the role tier. PostgREST therefore
-- fails every request with `role "web_anon" does not exist`, which
-- supabase-js surfaces as an empty {} error (its body-parsing path
-- doesn't pick up PostgREST's 400 cleanly), which surfaces in the app
-- as "Failed to read user profile: undefined." See issue 023.
--
-- Idempotent: only creates roles that don't already exist; only adds
-- grants and role memberships that aren't already in place. Safe to
-- re-run on every deploy.
--
-- Membership grants the connecting user (mikeadmin) the ability to
-- SET ROLE into web_anon / authenticated / service_role per request,
-- which is how PostgREST switches role identity.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'web_anon') then
    create role web_anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- The PG admin user (whoever ran the migration) needs membership in
-- each role so PostgREST's SET ROLE works on the connection it opens
-- as that admin user.
do $$
declare
  current_admin text := current_user;
begin
  execute format('grant web_anon to %I', current_admin);
  execute format('grant authenticated to %I', current_admin);
  execute format('grant service_role to %I', current_admin);
end $$;

-- Schema access. usage on schema is required for everything below.
grant usage on schema public to web_anon, authenticated, service_role;

-- Existing tables: explicit grants (alter default privileges only
-- affects tables created AFTER its declaration).
grant select on all tables in schema public to web_anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant select, usage on all sequences in schema public to authenticated;
grant all on all sequences in schema public to service_role;

-- Default privileges so future migrations creating tables / sequences
-- automatically pick up the right grants.
alter default privileges in schema public
  grant select on tables to web_anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant select, usage on sequences to authenticated;
alter default privileges in schema public
  grant all on sequences to service_role;

-- Tell PostgREST to refresh its schema cache after the role changes.
notify pgrst, 'reload schema';
