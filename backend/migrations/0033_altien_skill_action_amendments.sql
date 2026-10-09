-- OSS-7 Skills: amending an exact pending import action (user story 15).
--
-- A TenantAdmin may approve, amend, or reject a pending action. An amendment
-- never edits the reviewed payload in place — that would break the
-- payload-hash contract. It marks the reviewed action `superseded` and
-- proposes a NEW action whose payload hash covers exactly the amended
-- content, so approval still verifies the hash of what was displayed.

alter table public.altien_skill_pending_actions
  drop constraint if exists altien_skill_pending_actions_state_check;

alter table public.altien_skill_pending_actions
  add constraint altien_skill_pending_actions_state_check
  check (state in (
    'pending',
    'authorised',
    'executed',
    'rejected',
    'expired',
    'superseded'
  ));

-- The amendment chain stays auditable: which action replaced this one.
alter table public.altien_skill_pending_actions
  add column if not exists superseded_by_action_id uuid
    references public.altien_skill_pending_actions(id) on delete set null;

create index if not exists altien_skill_pending_actions_version_type_idx
  on public.altien_skill_pending_actions(version_id, action_type);
