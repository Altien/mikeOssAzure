-- Migration date: 2026-10-30
-- Upstream divergence (sync-log: ac1bee81): upstream builds these indexes
-- online (non-blocking) outside a transaction. Dev's numbered SQL runner
-- (node-pg-migrate SQL loader, src/scripts/migrationLedger.ts) runs every
-- file in a transaction and deliberately rejects nontransactional SQL
--, so Dev keeps the transactional build. Large
-- deployments should pre-build these online out of band; if not exists then
-- makes this file a no-op.
-- Cleanup must locate surviving references by key, not scan every live version.
create index if not exists document_versions_storage_path_idx
  on public.document_versions(storage_path) where deleted_at is null and storage_path is not null;
create index if not exists document_versions_pdf_storage_path_idx
  on public.document_versions(pdf_storage_path) where deleted_at is null and pdf_storage_path is not null;
