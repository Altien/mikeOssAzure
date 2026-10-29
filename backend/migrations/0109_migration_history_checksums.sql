-- Upstream sync: 49efc046acdedc54016171bdc691c58cab0e56d1
-- Dev already has authoritative numbered history. Extend that history instead
-- of creating a second schema_migrations ledger or baselining pending files.
alter table public.pgmigrations add column if not exists checksum text;
alter table public.pgmigrations drop constraint if exists pgmigrations_checksum_sha256;
alter table public.pgmigrations add constraint pgmigrations_checksum_sha256
  check (checksum is null or checksum ~ '^[0-9a-f]{64}$');

-- Existing rows deliberately remain NULL: their original file bytes were not
-- recorded. Only files successfully executed by the new runner gain a checksum.
-- Application startup reads names to warn about missing schema; it cannot
-- write history, including through broad historical/default grants.
revoke all on public.pgmigrations from public, web_anon, authenticated, service_role;
grant select on public.pgmigrations to service_role;
revoke all on sequence public.pgmigrations_id_seq from public, web_anon, authenticated, service_role;
