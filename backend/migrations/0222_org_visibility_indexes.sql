-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: 69556057): upstream's
-- 20261101_04_org_visibility_indexes.sql builds these online outside a
-- transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds them in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build them online out of band; if not exists then
-- makes this file a no-op.
-- Membership candidates: an organization's public projects/workflows are
-- reachable by every member without touching its private ones.
create index if not exists projects_org_visibility_idx
  on public.projects(org_id,visibility) where org_id is not null;
create index if not exists workflows_org_visibility_idx
  on public.workflows(org_id,visibility) where org_id is not null;
