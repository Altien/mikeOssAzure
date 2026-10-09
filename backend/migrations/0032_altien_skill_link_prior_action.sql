-- OSS-7 Skills: confirming a weak import-identity match is a pending action.
--
-- Import no longer attaches a ZIP draft to a prior skill on a frontmatter-name
-- match alone. The candidate is surfaced as a possible match and the
-- TenantAdmin authorizes an exact payload in the import review conversation,
-- so the action type needs to be allowed alongside the existing ones.

alter table public.altien_skill_pending_actions
  drop constraint if exists altien_skill_pending_actions_action_type_check;

alter table public.altien_skill_pending_actions
  add constraint altien_skill_pending_actions_action_type_check
  check (action_type in (
    'enable_version',
    'disable_version',
    'approve_contract',
    'rename_skill',
    'acquire_dependency',
    'link_prior_skill'
  ));
