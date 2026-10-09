-- 0042_workflow_legacy_ids.sql
--
-- Backfill the three legacy system-workflow ids that dev's frozen frontend
-- used to send, now that `lib/chat/contextBuilders.ts` no longer aliases them
-- (OSS-6 step D, spec §3.1 / decision 6):
--
--   builtin-cp-checklist   -> builtin-draft-cp-checklist
--   builtin-credit-summary -> builtin-credit-agreement-review
--   builtin-sha-summary    -> builtin-shareholder-agreement-review
--
-- Dev-only migration (upstream never shipped the legacy ids). Idempotent:
-- a second run finds no legacy rows.
--
-- Scope (decision 6): `hidden_workflows` only. Historical
-- `chat_messages.workflow` (jsonb display metadata, 0022) is left untouched;
-- it is display-only and never resolved through the workflow store.
--
-- `hidden_workflows` has `unique(user_id, workflow_id)`, so a user who hid
-- both the legacy and the current id keeps the current row and the legacy
-- row is deleted instead of renamed.

with legacy(old_id, new_id) as (
  values
    ('builtin-cp-checklist', 'builtin-draft-cp-checklist'),
    ('builtin-credit-summary', 'builtin-credit-agreement-review'),
    ('builtin-sha-summary', 'builtin-shareholder-agreement-review')
)
delete from public.hidden_workflows h
using legacy l
where h.workflow_id = l.old_id
  and exists (
    select 1
    from public.hidden_workflows cur
    where cur.user_id = h.user_id
      and cur.workflow_id = l.new_id
  );

with legacy(old_id, new_id) as (
  values
    ('builtin-cp-checklist', 'builtin-draft-cp-checklist'),
    ('builtin-credit-summary', 'builtin-credit-agreement-review'),
    ('builtin-sha-summary', 'builtin-shareholder-agreement-review')
)
update public.hidden_workflows h
set workflow_id = l.new_id
from legacy l
where h.workflow_id = l.old_id;
