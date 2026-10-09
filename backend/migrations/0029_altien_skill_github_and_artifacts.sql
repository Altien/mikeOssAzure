-- OSS-7 Skills: GitHub acquisition policy/provenance and adapted artifacts.

create table if not exists public.altien_skill_tenant_settings (
  tenant_id text primary key references public.tenants(tenant_id) on delete cascade,
  github_import_enabled boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.altien_skill_import_snapshots
  add column if not exists github_repository text,
  add column if not exists github_selected_path text,
  add column if not exists github_requested_ref text,
  add column if not exists github_resolved_commit_sha text;

alter table public.altien_skill_versions
  add column if not exists adapted_root_folder_id uuid
    references public.project_subfolders(id),
  add column if not exists adapted_manifest jsonb,
  add column if not exists adapted_content_hash text,
  add column if not exists adaptation_diff jsonb,
  add column if not exists adapted_at timestamptz;

create table if not exists public.altien_skill_developer_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  version_id uuid not null references public.altien_skill_versions(id) on delete cascade,
  requirement_name text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  source_hashes jsonb not null,
  generator_provenance jsonb not null,
  leakage_check jsonb not null,
  state text not null check (state in ('draft', 'approved', 'blocked')),
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists altien_skill_developer_artifacts_version_idx
  on public.altien_skill_developer_artifacts(version_id, created_at desc);
