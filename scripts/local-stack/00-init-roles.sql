-- Local-stack role bootstrap for PostgREST.
--
-- Mirrors the role topology that PostgREST expects (authenticator + anon +
-- authenticated). Runs once when the Postgres data volume is first
-- initialised — re-run it manually if you reset the volume only partially.
--
-- These roles are NOT created by the schema migration (0000_initial.sql)
-- because the Azure Bicep stack assumes pg_admin owns everything and roles
-- get added in a later issue (014/015). For local dev we need them up front
-- so PostgREST can connect.

-- ── authenticator ────────────────────────────────────────────────────────────
-- The login role PostgREST connects as. It has no privileges of its own;
-- PostgREST switches into web_anon or authenticated based on the JWT claim.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'devpassword';
  end if;
end $$;

-- ── web_anon (unauthenticated requests) ──────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'web_anon') then
    create role web_anon nologin;
  end if;
end $$;

-- ── authenticated (valid JWT) ────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- ── service_role (backend, full DML) ─────────────────────────────────────────
-- supabase-js sends its configured key as Authorization: Bearer; PostgREST
-- SET ROLEs into whatever the `role` claim says. The backend's "service key"
-- is now a JWT signed with JWT_SECRET claiming role=service_role, so this
-- role needs full DML on the schema.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant web_anon, authenticated, service_role to authenticator;

-- ── Schema access ────────────────────────────────────────────────────────────
grant usage on schema public to web_anon, authenticated, service_role;

-- Default privileges so future tables created by node-pg-migrate are
-- automatically granted to the right roles. The migration runs as mikeadmin,
-- so default privileges have to be set FOR that role.
alter default privileges for role mikeadmin in schema public
  grant select on tables to web_anon;

alter default privileges for role mikeadmin in schema public
  grant select, insert, update, delete on tables to authenticated;

alter default privileges for role mikeadmin in schema public
  grant usage, select on sequences to authenticated;

alter default privileges for role mikeadmin in schema public
  grant all on tables to service_role;

alter default privileges for role mikeadmin in schema public
  grant all on sequences to service_role;
