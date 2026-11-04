-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: fa310552): upstream's
-- 20261101_20_private_catalogue_indexes.sql builds these online outside a
-- transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds them in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build them online out of band; if not exists then
-- makes this file a no-op.
-- list_org_private_content pages an organization's private catalogue by
-- lower(title), item id. Each kind's catalogue rows, in that order, so a
-- page reads about offset + limit rows per kind instead of sorting them all.
create index if not exists projects_private_catalogue_idx
  on public.projects(org_id,lower(name),id) where archived_at is null and visibility = 'private';
create index if not exists workflows_private_catalogue_idx
  on public.workflows(org_id,lower(title),id) where archived_at is null and visibility = 'private';
create index if not exists chats_private_catalogue_idx
  on public.chats(org_id,lower(title),id) where archived_at is null and project_id is null;
create index if not exists tabular_reviews_private_catalogue_idx
  on public.tabular_reviews(org_id,lower(title),id) where archived_at is null and project_id is null;
