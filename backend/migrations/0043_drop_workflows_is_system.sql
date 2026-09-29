-- 0043_drop_workflows_is_system.sql
--
-- OPERATORS: before deploying this to a database that holds data, run
--
--   select count(*), count(user_id) from workflows where is_system;
--
-- and review the result. `count(user_id)` rows are KEPT as ordinary user
-- workflows; the remaining `count(*) - count(user_id)` owner-less rows are
-- DELETED (`workflow_shares` / submissions cascade, `tabular_reviews.
-- workflow_id` is set null, `hidden_workflows` text ids simply stop matching).
-- If either number is unexpected, stop and decide per row before deploying.
--
-- Drops the legacy `workflows.is_system` column (OSS-6 step E, spec §3.1 /
-- §3.2, decision 5). System workflows are code (`SYSTEM_WORKFLOWS` in
-- `backend/src/lib/systemWorkflows.ts`, served by `GET /workflows`), not rows.
-- Since 0040 the `get_workflows_overview` RPC returns a constant
-- `false as is_system` and no route reads the column, so it is dead.
--
-- Upstream dropped the column inside `20260625_01_workflow_metadata.sql`;
-- dev split that drop out of 0040 (§4.3: never drop a column in the migration
-- that introduces its replacement). Upstream divergence (sync-log: OSS-6).
--
-- Decision 5 default:
--   * `is_system` rows WITH a `user_id` become ordinary user rows (the flag is
--     simply cleared, which the column drop does);
--   * owner-less `is_system` rows are deleted — the code serves every system
--     workflow, so they are unreachable duplicates.
--
-- Idempotent: every statement is guarded by the column's existence, and the
-- drop is `if exists`, so a second run is a no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflows'
      and column_name = 'is_system'
  ) then
    execute 'delete from public.workflows where is_system and user_id is null';
  end if;
end
$$;

alter table public.workflows drop column if exists is_system;
