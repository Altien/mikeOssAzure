-- 0008_courtlistener_and_document_version_metadata.sql
--
-- Brings existing dev databases in line with upstream 44e868e ("Add
-- courtlistener intergration, liquid glass redesign, UI improvements,
-- version control, various fixes"). Adapted from upstream's
-- backend/oss-migrations/20260606_oss_schema_diff.sql with dev's rules
-- applied (no Supabase roles; destructive drops deferred per
-- internal design notes §4.3).
--
-- Differences from upstream's incremental file:
--   1. user_profiles.title_model / quote_model NOT added — dev's
--      fast_model (0004) covers the title-model preference and nothing
--      reads quote_model.
--   2. Provider check includes dev's azure_openai in addition to
--      upstream's new openrouter/courtlistener.
--   3. Legacy column DROPs (documents.filename/file_type/size_bytes/
--      page_count/structure_tree, document_versions.display_name) are
--      DEFERRED to a follow-up migration after the backfill below has
--      been verified in every environment. documents.filename only has
--      its NOT NULL relaxed so new inserts (which no longer write it)
--      succeed.
--   4. No anon/authenticated revokes (Supabase-only roles).

-- ---------------------------------------------------------------------------
-- User API keys: extend provider check (openrouter, courtlistener)
-- ---------------------------------------------------------------------------

alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in (
    'claude', 'gemini', 'openai', 'openrouter', 'courtlistener',
    'azure_openai'
  ));

-- ---------------------------------------------------------------------------
-- Document metadata now lives on document_versions
-- ---------------------------------------------------------------------------

alter table public.document_versions
  add column if not exists filename text,
  add column if not exists file_type text,
  add column if not exists size_bytes integer,
  add column if not exists page_count integer;

-- Backfill from document_versions.display_name, then from the parent
-- documents row. Idempotent — only fills blanks.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'document_versions'
      and column_name = 'display_name'
  ) then
    update public.document_versions dv
    set filename = dv.display_name
    where (dv.filename is null or btrim(dv.filename) = '')
      and dv.display_name is not null
      and btrim(dv.display_name) <> '';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'filename'
  ) then
    update public.document_versions dv
    set filename = d.filename
    from public.documents d
    where dv.document_id = d.id
      and (dv.filename is null or btrim(dv.filename) = '')
      and d.filename is not null
      and btrim(d.filename) <> '';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'file_type'
  ) then
    update public.document_versions dv
    set file_type = coalesce(nullif(btrim(dv.file_type), ''), d.file_type)
    from public.documents d
    where dv.document_id = d.id
      and (dv.file_type is null or btrim(dv.file_type) = '');
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'size_bytes'
  ) then
    update public.document_versions dv
    set size_bytes = d.size_bytes
    from public.documents d
    where dv.document_id = d.id
      and dv.size_bytes is null
      and d.size_bytes is not null;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'page_count'
  ) then
    update public.document_versions dv
    set page_count = d.page_count
    from public.documents d
    where dv.document_id = d.id
      and dv.page_count is null
      and d.page_count is not null;
  end if;
end $$;

-- New code no longer writes documents.filename; relax the NOT NULL so
-- inserts succeed on databases that still carry the legacy column.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'documents'
      and column_name = 'filename'
  ) then
    alter table public.documents alter column filename drop not null;
  end if;
end $$;

-- One row per (document_id, version_number) — upstream f32a194
-- ("document safety updates"). NULL version_numbers (legacy rows)
-- remain allowed; Postgres unique treats NULLs as distinct.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_doc_version_unique'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_doc_version_unique
      unique (document_id, version_number);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- CourtListener bulk-data indexes
-- ---------------------------------------------------------------------------

create table if not exists public.courtlistener_citation_index (
  id bigint primary key,
  volume text not null,
  reporter text not null,
  page text not null,
  type integer,
  cluster_id bigint not null,
  date_created timestamptz,
  date_modified timestamptz
);

create index if not exists courtlistener_citation_lookup_idx
  on public.courtlistener_citation_index(volume, reporter, page);

create index if not exists courtlistener_citation_cluster_idx
  on public.courtlistener_citation_index(cluster_id);

create table if not exists public.courtlistener_opinion_cluster_index (
  id bigint primary key,
  case_name text,
  case_name_short text,
  case_name_full text,
  slug text,
  date_filed date,
  citation_count integer,
  precedential_status text,
  filepath_pdf_harvard text,
  filepath_json_harvard text,
  docket_id bigint
);
