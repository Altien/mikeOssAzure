-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: bc0edec1): upstream's
-- 20261101_15_db_jobs_payload_indexes.sql builds these online outside a
-- transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds them in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build them online out of band; if not exists then
-- makes this file a no-op.
-- Payload lookups the backend runs against db_jobs. Without these each one
-- reads the whole queue table, done and failed history included:
--  * account erasure deletes every job naming the user (payload userId, or
--    base.userId) and lists that user's export.build jobs;
--  * account erasure lists the user's memory.consolidate jobs by actorUserId
--    in any status (the epoch index covers only live ones);
--  * document_cache_writer_active and the inline text runner find a
--    version's precompute/extract jobs by versionId.
-- Partial predicates keep each index to the rows that carry the key; an
-- equality on the expression implies "is not null", so the planner can use
-- them for parameterized queries.
create index if not exists db_jobs_payload_user_idx
  on public.db_jobs((payload->>'userId')) where (payload->>'userId') is not null;
create index if not exists db_jobs_payload_base_user_idx
  on public.db_jobs((payload->'base'->>'userId')) where (payload->'base'->>'userId') is not null;
create index if not exists db_jobs_memory_actor_idx
  on public.db_jobs((payload->>'actorUserId')) where kind = 'memory.consolidate';
create index if not exists db_jobs_text_version_idx
  on public.db_jobs((payload->>'versionId'))
  where kind in ('document.extract_text', 'document.precompute_text');
