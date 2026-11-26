-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: ac1bee81): upstream's
-- 20261101_01_list_candidate_indexes_online.sql builds these online
-- (non-blocking) outside a transaction. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev keeps
-- upstream's file layout but builds them in this file's transaction (SHARE
-- lock for the build only, no longer held across 0210/0212's function
-- definitions). Large deployments should pre-build them online out of band;
-- if not exists then makes this file a no-op.
-- Indexes for the 0210 (upstream 20261030_05) and 0212 (20261030_07)
-- candidate lookups.
create index if not exists org_private_content_access_actor_kind_idx
  on public.org_private_content_access(user_id,kind,org_id,item_id);
create index if not exists workflow_shares_lower_email_idx
  on public.workflow_shares(lower(shared_with_email));
