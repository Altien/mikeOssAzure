-- 0022_citation_verification_extractions.sql
--
-- Provenance for deterministic DOCX/PDF -> Markdown records created by the
-- general extract_document_for_verification tool.

create table if not exists public.citation_verification_extractions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  source_document_id uuid not null references public.documents(id) on delete cascade,
  source_version_id uuid not null references public.document_versions(id) on delete cascade,
  extracted_document_id uuid not null references public.documents(id) on delete cascade,
  extracted_version_id uuid not null references public.document_versions(id) on delete cascade,
  options jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  source_sha256 text not null,
  extracted_sha256 text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_citation_verification_extractions_source
  on public.citation_verification_extractions(source_version_id, created_at desc);

create index if not exists idx_citation_verification_extractions_output
  on public.citation_verification_extractions(extracted_version_id);
