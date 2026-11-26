-- Migration date: 2026-11-01
-- Upstream: 20261101_23_document_text_backfill_from_unfinished.sql (sync-log: b7f8eb0d).
-- Dev: Dev's live backfill_document_text (0137) equals upstream's parent;
-- queue_document_text (0174) differs only by the precompute-claim path and
-- writes the same pending row; document_text_changed is identical. Upstream
-- divergence: document_version_texts and document_versions are tenant
-- tables under forced RLS (0180), so the upgrade normalization runs as
-- service_role (0180's data-migration rule, as 0193 does) and the inserted
-- rows take their version's tenant_id (composite (tenant_id, version_id)
-- FK) instead of the request default.
-- backfill_document_text (every 10 minutes from the maintenance sweep)
-- joined every live document version to its text row on every run, even
-- with nothing to do, and sorted the whole set. It now starts from the
-- unfinished text rows. That relies on every live version having a text
-- row at its current revision and extractor; the triggers keep that true
-- for every write since text search shipped, and the two statements below
-- make it true for older versions (and any row left stale) by recording
-- them as pending, exactly as queue_document_text would. Readers already
-- treat a missing row and a pending row the same.
set local role service_role;
insert into public.document_version_texts(tenant_id,version_id,source_revision)
select v.tenant_id,v.id,v.text_revision from public.document_versions v
where v.deleted_at is null and v.storage_path is not null
  and not exists(select 1 from public.document_version_texts t where t.version_id=v.id)
on conflict (version_id) do nothing;
update public.document_version_texts t
   set source_revision=v.text_revision,extractor_version=1,status='pending',text_content=null,
       source_sha256=null,textless_page_count=null,error_code=null,updated_at=now()
  from public.document_versions v
 where v.id=t.version_id and v.deleted_at is null and v.storage_path is not null
   and (t.source_revision<>v.text_revision or t.extractor_version<>1);
reset role;

create or replace function public.backfill_document_text(p_limit integer default 100, p_retry_failed boolean default false)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare row record; queued integer := 0;
begin
  -- Work starts from the unfinished text rows (partial index). Every live
  -- version with a source file has a row for its current revision and
  -- extractor: document_text_changed queues one on insert and on every
  -- revision change, and 0241 turned versions from before text
  -- search into pending rows. So no live version is missing a row or has a
  -- stale one, and "pending or processing" is the whole old work list.
  -- Bumping extractor_version must turn its outdated rows pending likewise.
  for row in
    select v.id from public.document_version_texts t
    join public.document_versions v on v.id=t.version_id
    join public.documents d on d.id=v.document_id
    where t.status <> 'ready'
      and (t.status in ('pending','processing') or (p_retry_failed and t.status='failed'))
      and v.deleted_at is null and v.storage_path is not null and d.archived_at is null
      and not exists(select 1 from public.db_jobs j where j.dedupe_key='document.text:'||v.id||':'||v.text_revision
        and j.status in ('pending','running'))
    order by (v.id=d.current_version_id) desc, v.id
    limit least(greatest(coalesce(p_limit,100),1),500)
    for update of v skip locked
  loop
    if public.queue_document_text(row.id,p_retry_failed) then queued:=queued+1; end if;
  end loop;
  return queued;
end;
$$;
