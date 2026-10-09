-- OSS-7 Skills: review conversation, exact approvals, and project-bound runs.

alter table public.altien_skill_import_snapshots
  add column if not exists deterministic_findings jsonb not null default '{}'::jsonb;

alter table public.altien_skill_versions
  add column if not exists analysis_state text not null default 'pending'
    check (analysis_state in ('pending', 'running', 'succeeded', 'failed')),
  add column if not exists analysis_provider text,
  add column if not exists analysis_model text,
  add column if not exists analysis_schema_version integer,
  add column if not exists analysis_input_hash text,
  add column if not exists analysis_completed_at timestamptz,
  add column if not exists generated_analysis jsonb not null default '{}'::jsonb,
  add column if not exists approved_execution_contract jsonb not null default '{}'::jsonb,
  add column if not exists enabled_by text,
  add column if not exists enabled_at timestamptz;

create table if not exists public.altien_skill_import_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  version_id uuid not null references public.altien_skill_versions(id) on delete cascade,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(version_id)
);

create table if not exists public.altien_skill_import_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.altien_skill_import_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  actor_user_id text,
  content text not null,
  structured_content jsonb,
  created_at timestamptz not null default now()
);

create index if not exists altien_skill_import_messages_conversation_idx
  on public.altien_skill_import_messages(conversation_id, created_at);

create table if not exists public.altien_skill_pending_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  conversation_id uuid not null
    references public.altien_skill_import_conversations(id) on delete cascade,
  version_id uuid not null references public.altien_skill_versions(id) on delete cascade,
  proposed_by_message_id uuid
    references public.altien_skill_import_messages(id) on delete set null,
  action_type text not null check (action_type in (
    'enable_version',
    'disable_version',
    'approve_contract',
    'rename_skill',
    'acquire_dependency'
  )),
  payload jsonb not null,
  payload_hash text not null,
  state text not null default 'pending'
    check (state in ('pending', 'authorised', 'executed', 'rejected', 'expired')),
  authorised_by text,
  authorised_by_message_id uuid
    references public.altien_skill_import_messages(id) on delete set null,
  authorised_at timestamptz,
  execution_result jsonb,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);

create index if not exists altien_skill_pending_actions_conversation_idx
  on public.altien_skill_pending_actions(conversation_id, created_at desc);

create table if not exists public.altien_chat_skill_bindings (
  chat_id uuid primary key references public.chats(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  root_skill_id uuid not null references public.altien_skills(id) on delete restrict,
  root_version_id uuid not null
    references public.altien_skill_versions(id) on delete restrict,
  bound_by text not null,
  dependency_versions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists altien_chat_skill_bindings_tenant_project_idx
  on public.altien_chat_skill_bindings(tenant_id, project_id);

create table if not exists public.altien_project_skill_pins (
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  skill_id uuid not null references public.altien_skills(id) on delete cascade,
  version_id uuid not null references public.altien_skill_versions(id) on delete restrict,
  pinned_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id, skill_id)
);

create table if not exists public.altien_skill_dependencies (
  version_id uuid not null references public.altien_skill_versions(id) on delete cascade,
  dependency_skill_id uuid not null references public.altien_skills(id) on delete restrict,
  dependency_version_id uuid not null
    references public.altien_skill_versions(id) on delete restrict,
  required boolean not null default true,
  approved_by text not null,
  created_at timestamptz not null default now(),
  primary key(version_id, dependency_skill_id),
  check (version_id <> dependency_version_id)
);
