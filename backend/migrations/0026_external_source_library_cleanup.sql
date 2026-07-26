-- 0026_external_source_library_cleanup.sql
--
-- The SQL-text cache was never populated before external sources moved into
-- the DMS, so retain no speculative legacy representation. Provenance projects
-- are installation-wide per provider; access remains on scoped retrieval rows.

alter table public.external_source_cache
  drop column if exists content_text;

drop index if exists public.projects_external_provenance_unique;

update public.projects
set user_id = 'system:external-provenance'
where project_kind = 'external_provenance';

update public.documents d
set user_id = 'system:external-provenance'
from public.projects p
where d.project_id = p.id
  and p.project_kind = 'external_provenance';

create unique index if not exists projects_external_provenance_key_unique
  on public.projects(provenance_key)
  where project_kind = 'external_provenance';
