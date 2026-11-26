-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: b7f8eb0d): upstream's
-- 20261101_22_document_text_unfinished_index.sql builds this online outside
-- a transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds it in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build it online out of band; if not exists then
-- makes this file a no-op.
-- backfill_document_text's work list: text rows not yet ready. Ready rows
-- (almost all of them) stay out of the index.
create index if not exists document_version_texts_unfinished_idx
  on public.document_version_texts(status,version_id) where status <> 'ready';
