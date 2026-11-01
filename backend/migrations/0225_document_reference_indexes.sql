-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: c18c1ccd): upstream's
-- 20261101_07_document_reference_indexes.sql builds these online outside a
-- transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds them in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build them online out of band; if not exists then
-- makes this file a no-op.
-- Reverse document references: which chat messages and reviews name one
-- document. jsonb_path_ops serves files @> '[{"document_id":"..."}]';
-- document_ids needs the default opclass for its ? (key/element) test, and
-- no partial predicate: the planner cannot prove "document_ids is not null"
-- from a ? test against a parameter, so a partial index would go unused.
create index if not exists chat_messages_files_idx
  on public.chat_messages using gin (files jsonb_path_ops) where files is not null;
create index if not exists tabular_reviews_document_ids_idx
  on public.tabular_reviews using gin (document_ids);
