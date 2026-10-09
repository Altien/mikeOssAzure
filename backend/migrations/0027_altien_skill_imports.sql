-- OSS-7 Skills: organisation-owned immutable import snapshots and drafts.

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'external_retrieval'::text,
      'skill_import'::text
    ]));

create unique index if not exists projects_skill_library_provenance_unique
  on public.projects(provenance_key)
  where project_kind = 'skill_library';

create table if not exists public.altien_skill_import_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  imported_by text not null,
  source_kind text not null check (source_kind in ('zip', 'github')),
  source_filename text,
  dms_project_id uuid not null references public.projects(id),
  root_folder_id uuid not null references public.project_subfolders(id),
  source_document_id uuid references public.documents(id),
  source_document_version_id uuid references public.document_versions(id),
  manifest jsonb not null,
  tree_hash text not null,
  expanded_bytes integer not null,
  file_count integer not null,
  status text not null default 'stored'
    check (status in (
      'validating',
      'rejected',
      'stored',
      'analysing',
      'analysis_failed',
      'ready'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists altien_skill_import_snapshots_tenant_created_idx
  on public.altien_skill_import_snapshots(tenant_id, created_at desc);

create table if not exists public.altien_skills (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  canonical_name text not null,
  display_name text not null,
  description text not null,
  current_version_id uuid,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(tenant_id, canonical_name)
);

create index if not exists altien_skills_tenant_state_idx
  on public.altien_skills(tenant_id, deleted_at);

create table if not exists public.altien_skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.altien_skills(id) on delete cascade,
  snapshot_id uuid not null
    references public.altien_skill_import_snapshots(id) on delete restrict,
  entrypoint_path text not null,
  root_path text not null default '',
  declared_name text not null,
  declared_version text,
  declared_metadata jsonb not null default '{}'::jsonb,
  original_content_hash text not null,
  state text not null default 'draft'
    check (state in (
      'draft',
      'blocked',
      'enabled',
      'disabled',
      'superseded',
      'deleted'
    )),
  deterministic_analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(skill_id, original_content_hash)
);

create index if not exists altien_skill_versions_skill_created_idx
  on public.altien_skill_versions(skill_id, created_at desc);

alter table public.altien_skills
  drop constraint if exists altien_skills_current_version_id_fkey;

alter table public.altien_skills
  add constraint altien_skills_current_version_id_fkey
  foreign key (current_version_id)
  references public.altien_skill_versions(id) on delete set null;
