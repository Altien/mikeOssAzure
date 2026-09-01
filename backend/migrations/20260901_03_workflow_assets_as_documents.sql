-- Migration date: 2026-09-01
-- Store user workflow assets in the standard document/version model and
-- rename the system catalog's file collection to assets.

alter table public.documents
  add column if not exists workflow_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_workflow_id_fkey'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_workflow_id_fkey
      foreign key (workflow_id)
      references public.workflows(id)
      on delete cascade;
  end if;
end
$$;

create index if not exists idx_documents_workflow
  on public.documents(workflow_id, created_at)
  where workflow_id is not null;

alter table public.documents
  drop constraint if exists documents_library_kind_check;

alter table public.documents
  add constraint documents_library_kind_check
  check (library_kind in ('file', 'template', 'workflow_asset'));

do $$
begin
  if to_regclass('public.workflow_reference_documents') is not null then
    insert into public.documents (
      id,
      project_id,
      user_id,
      status,
      folder_id,
      library_kind,
      library_folder_id,
      workflow_id,
      created_at,
      updated_at
    )
    select
      asset.id,
      null,
      asset.user_id,
      'ready',
      null,
      'workflow_asset',
      null,
      asset.workflow_id,
      asset.created_at,
      asset.updated_at
    from public.workflow_reference_documents asset
    on conflict (id) do update set
      workflow_id = excluded.workflow_id,
      library_kind = 'workflow_asset',
      status = 'ready',
      updated_at = excluded.updated_at;

    insert into public.document_versions (
      id,
      document_id,
      storage_path,
      pdf_storage_path,
      source,
      version_number,
      filename,
      file_type,
      size_bytes,
      page_count,
      content_sha256,
      created_at
    )
    select
      asset.id,
      asset.id,
      asset.storage_path,
      null,
      'upload',
      1,
      asset.filename,
      asset.file_type,
      asset.size_bytes,
      null,
      asset.content_hash,
      asset.created_at
    from public.workflow_reference_documents asset
    on conflict (id) do nothing;

    update public.documents document
    set current_version_id = asset.id
    from public.workflow_reference_documents asset
    where document.id = asset.id
      and document.current_version_id is null;

    drop table public.workflow_reference_documents;
  end if;
end
$$;

drop table if exists public.workflow_addon_reference_files;

do $$
begin
  if to_regclass('public.mike_workflow_reference_files') is not null
     and to_regclass('public.mike_workflow_assets') is null then
    alter table public.mike_workflow_reference_files
      rename to mike_workflow_assets;
  end if;
end
$$;

alter index if exists public.mike_workflow_reference_files_name_unique
  rename to mike_workflow_assets_name_unique;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'mike_workflow_reference_files_pkey'
      and conrelid = 'public.mike_workflow_assets'::regclass
  ) then
    alter table public.mike_workflow_assets
      rename constraint mike_workflow_reference_files_pkey
      to mike_workflow_assets_pkey;
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'mike_workflow_reference_files_mike_workflow_id_fkey'
      and conrelid = 'public.mike_workflow_assets'::regclass
  ) then
    alter table public.mike_workflow_assets
      rename constraint mike_workflow_reference_files_mike_workflow_id_fkey
      to mike_workflow_assets_mike_workflow_id_fkey;
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'mike_workflow_reference_files_hash_check'
      and conrelid = 'public.mike_workflow_assets'::regclass
  ) then
    alter table public.mike_workflow_assets
      rename constraint mike_workflow_reference_files_hash_check
      to mike_workflow_assets_hash_check;
  end if;
end
$$;

create or replace function public.replace_mike_workflows(
  p_source_commit text,
  p_workflows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  asset_item jsonb;
  asset_items jsonb;
  jurisdiction_values text[];
  workflow_uuid uuid;
begin
  if p_source_commit !~ '^[0-9a-f]{40}$' then
    raise exception 'invalid workflow catalog source commit';
  end if;
  if jsonb_typeof(p_workflows) <> 'array' then
    raise exception 'workflow catalog payload must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mike_workflows', 0));
  update public.mike_workflows set active = false where active;

  for item in select value from jsonb_array_elements(p_workflows)
  loop
    jurisdiction_values := null;
    if jsonb_typeof(item->'jurisdictions') = 'array' then
      select array_agg(value)
        into jurisdiction_values
      from jsonb_array_elements_text(item->'jurisdictions');
    end if;

    insert into public.mike_workflows (
      workflow_key, distribution, version, title, description, type,
      prompt_md, columns_config, contributors, language, practice,
      jurisdictions, pack_key, pack_title, pack_description, pack_version,
      default_sort_order, quick_action_name, quick_action_prompt,
      document_upload, word_quick_action, word_quick_action_prompt,
      source_commit, content_hash, active, updated_at
    ) values (
      item->>'workflow_key',
      item->>'distribution',
      nullif(item->>'version', ''),
      item->>'title',
      nullif(item->>'description', ''),
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case when jsonb_typeof(item->'columns_config') = 'array'
        then item->'columns_config' else null end,
      case when jsonb_typeof(item->'contributors') = 'array'
        then item->'contributors' else '[]'::jsonb end,
      nullif(item->>'language', ''),
      nullif(item->>'practice', ''),
      jurisdiction_values,
      nullif(item->>'pack_key', ''),
      nullif(item->>'pack_title', ''),
      nullif(item->>'pack_description', ''),
      nullif(item->>'pack_version', ''),
      nullif(item->>'default_sort_order', '')::integer,
      nullif(item->>'quick_action_name', ''),
      nullif(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      coalesce((item->>'word_quick_action')::boolean, false),
      nullif(item->>'word_quick_action_prompt', ''),
      p_source_commit,
      item->>'content_hash',
      true,
      now()
    )
    on conflict (workflow_key, content_hash) do update set
      distribution = excluded.distribution,
      version = excluded.version,
      title = excluded.title,
      description = excluded.description,
      type = excluded.type,
      prompt_md = excluded.prompt_md,
      columns_config = excluded.columns_config,
      contributors = excluded.contributors,
      language = excluded.language,
      practice = excluded.practice,
      jurisdictions = excluded.jurisdictions,
      pack_key = excluded.pack_key,
      pack_title = excluded.pack_title,
      pack_description = excluded.pack_description,
      pack_version = excluded.pack_version,
      default_sort_order = excluded.default_sort_order,
      quick_action_name = excluded.quick_action_name,
      quick_action_prompt = excluded.quick_action_prompt,
      document_upload = excluded.document_upload,
      word_quick_action = excluded.word_quick_action,
      word_quick_action_prompt = excluded.word_quick_action_prompt,
      source_commit = excluded.source_commit,
      active = true,
      updated_at = now()
    returning id into workflow_uuid;

    delete from public.mike_workflow_assets
    where mike_workflow_id = workflow_uuid;

    -- reference_files remains a rollout-only alias for catalog payloads
    -- produced immediately before workflow assets were renamed.
    asset_items := coalesce(item->'assets', item->'reference_files');
    if asset_items is not null then
      if jsonb_typeof(asset_items) <> 'array' then
        raise exception 'workflow assets must be an array';
      end if;
      for asset_item in
        select value from jsonb_array_elements(asset_items)
      loop
        insert into public.mike_workflow_assets (
          mike_workflow_id, filename, file_type, storage_path,
          size_bytes, content_hash
        ) values (
          workflow_uuid,
          asset_item->>'filename',
          asset_item->>'file_type',
          asset_item->>'storage_path',
          nullif(asset_item->>'size_bytes', '')::integer,
          asset_item->>'content_hash'
        );
      end loop;
    end if;
  end loop;
end;
$$;

revoke all on public.mike_workflow_assets from anon, authenticated;
grant select, insert, update, delete
  on public.mike_workflow_assets
  to service_role;
