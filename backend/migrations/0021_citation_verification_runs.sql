-- 0021_citation_verification_runs.sql
--
-- Authority Trace issue 001: immutable, integrity-bound citation
-- verification runs. Human review records arrive in a later migration.

create table if not exists public.citation_verification_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  memo_document_id uuid not null references public.documents(id) on delete cascade,
  memo_version_id uuid not null references public.document_versions(id) on delete restrict,
  verified_record jsonb not null,
  report jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_citation_verification_runs_project_created
  on public.citation_verification_runs(project_id, created_at desc);

create index if not exists idx_citation_verification_runs_user_created
  on public.citation_verification_runs(user_id, created_at desc);
