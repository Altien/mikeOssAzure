-- Migration date: 2026-09-04
-- Sequence 02 deliberately: 20260904_01 is reserved for the playbooks
-- migration in the upstream PR, so this avoids a collision if that lands here.
-- Graded materiality for monitor developments. The threshold defaults to
-- 'low', which filters nothing, so existing monitors keep their current
-- behaviour until an owner raises it.

alter table public.legal_monitors
  add column if not exists materiality_threshold text not null default 'low';
