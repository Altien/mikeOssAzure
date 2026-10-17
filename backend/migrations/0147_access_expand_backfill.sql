-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_04_playbook_access.sql
-- Staging order 06; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Migration date: 2026-10-17
-- Playbook access matches workflows: people are given a role (owner, editor
-- or viewer) instead of a bare list of addresses. A personal playbook is
-- shared by email; an organization's playbook is shared with its members,
-- who can also be denied a public one. Unlike a workflow, a public playbook
-- gives members view-and-run access by default; editing is granted per
-- person, because a playbook's rules are the organization's policy.
create table if not exists public.playbook_shares (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  shared_by_user_id text,
  shared_with_email text not null,
  role text not null default 'viewer'
    check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  constraint playbook_shares_playbook_email_unique
    unique (playbook_id, shared_with_email),
  -- Canonical case, like workflow_shares: the unique constraint and the
  -- access lookup must agree on who a recipient is.
  constraint playbook_shares_email_lowercase
    check (shared_with_email = lower(shared_with_email))
);
create index if not exists idx_playbook_shares_email
  on public.playbook_shares(shared_with_email);

create table if not exists public.playbook_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null constraint playbook_org_access_overrides_role_check
    check (role in ('owner', 'editor', 'viewer', 'deny')),
  assigned_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (playbook_id, user_id),
  -- Leaving the organization removes the grant.
  foreign key (org_id, user_id)
    references public.org_members(org_id, user_id) on delete cascade
);
create index if not exists idx_playbook_org_access_overrides_user
  on public.playbook_org_access_overrides(user_id);

-- Existing recipients could view and run, which is the viewer role.
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbooks'
      and column_name = 'shared_with') then
    insert into public.playbook_shares
      (playbook_id, shared_by_user_id, shared_with_email, role)
    select b.id, b.user_id, lower(trim(email)), 'viewer'
    from public.playbooks b, unnest(b.shared_with) as email
    where b.org_id is null and trim(email) <> ''
    on conflict (playbook_id, shared_with_email) do nothing;
  end if;
end $$;


revoke all privileges on table public.playbook_shares,
  public.playbook_org_access_overrides from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_shares,
  public.playbook_org_access_overrides to service_role;

notify pgrst, 'reload schema';
