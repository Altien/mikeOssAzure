-- Azure lifecycle probe and cleanup-reference RPCs. Dev atomic upload publishing
-- already fences claim generations, so document_created_at is retained only as
-- a compatible marker; the publisher never depends on an unfenced upsert.
begin;
-- Migration date: 2026-09-16
-- Record, on the upload file row, the moment the worker wrote the destination
-- documents row for a `document_create` upload.
--
-- Why: a retried upload must not resurrect a document the user deleted while
-- the first attempt was running, but it also must not give up when the first
-- attempt failed BEFORE the row existed (a storage read error, a transient
-- database error on the upsert itself). Nothing durable distinguished those
-- two "row is missing on retry" cases; the attempt counter cannot. This
-- column can: it is set only after the upsert succeeded, so on a retry
--   marker set   + row missing  => the row was deleted, stop for good;
--   marker unset + row missing  => the row was never written, create it.
-- Existing rows stay null, which reads as "never written" and lets any
-- in-flight retry proceed exactly as it did before this migration.
alter table public.upload_session_files
  add column if not exists document_created_at timestamptz;

-- The backend refuses to serve when the lifecycle contract it depends on is
-- not installed (lib/dbq/lifecycleGuard.ts). The marker column is part of
-- that contract from this migration on: the worker stamps it after every
-- documents upsert and treats a failed stamp as a failed upload, so code
-- deployed ahead of this file would fail every new-document upload while the
-- version-1 probe still reported the database healthy. Version 2 = the five
-- lifecycle RPCs AND the column.
create or replace function public.document_lifecycle_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- 20260914_01: the five lifecycle RPCs. Without them every upload,
    -- version and edit fails and deletes orphan their objects.
    when (
      select count(distinct p.proname)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'create_document_version',
           'create_document_versions',
           'activate_document_version',
           'delete_document_version',
           'queue_document_version_cleanup'
         )
    ) <> 5 then 0
    -- 20260916_01: the upload retry marker. Code that stamps it against a
    -- database without the column fails every new-document upload, so the
    -- guard has to count it as part of the contract.
    when not exists (
      select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = 'upload_session_files'
         and a.attname = 'document_created_at'
         and a.attnum > 0
         and not a.attisdropped
    ) then 1
    else 2
  end;
$$;
revoke all on function public.document_lifecycle_version()
  from public, web_anon, authenticated;
grant execute on function public.document_lifecycle_version() to service_role;

-- Reference checks for the cleanup worker, as RPCs so the key list travels in
-- the POST body. The previous `in(...)` filters put up to 500 storage paths in
-- the request URL; the deployment gateway answered 414 (Request-URI Too
-- Large) at about 100 ordinary paths, so a coalesced cleanup run failed
-- before deleting anything and every retry rebuilt the same oversized batch.
create or replace function public.document_cleanup_referenced_keys(p_keys text[])
returns table(key text)
language sql
stable
security definer
set search_path = ''
as $$
  select v.storage_path
    from public.document_versions v
   where v.deleted_at is null
     and v.storage_path = any(p_keys)
  union
  select v.pdf_storage_path
    from public.document_versions v
   where v.deleted_at is null
     and v.pdf_storage_path = any(p_keys);
$$;
revoke all on function public.document_cleanup_referenced_keys(text[])
  from public, web_anon, authenticated;
grant execute on function public.document_cleanup_referenced_keys(text[])
  to service_role;

create or replace function public.document_cache_writer_active(p_version_ids text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.db_jobs j
     where j.kind = 'document.precompute_text'
       and j.status = 'running'
       and (j.payload->>'versionId') = any(p_version_ids)
  );
$$;
revoke all on function public.document_cache_writer_active(text[])
  from public, web_anon, authenticated;
grant execute on function public.document_cache_writer_active(text[])
  to service_role;

commit;
notify pgrst, 'reload schema';
