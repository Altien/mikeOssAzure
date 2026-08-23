-- Migration date: 2026-08-23
-- Store every Mike-authored workflow in one versioned runtime catalog.

create table if not exists public.mike_workflows (
  id uuid primary key default gen_random_uuid(),
  workflow_key text not null,
  distribution text not null,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  default_sort_order integer,
  quick_action_name text,
  quick_action_prompt text,
  document_upload boolean not null default false,
  word_quick_action boolean not null default false,
  word_quick_action_prompt text,
  source_commit text,
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mike_workflows_key_hash_unique
    unique(workflow_key, content_hash),
  constraint mike_workflows_distribution_check
    check(distribution in ('default', 'addon')),
  constraint mike_workflows_type_check
    check(type in ('assistant', 'tabular')),
  constraint mike_workflows_source_commit_check
    check(source_commit is null or source_commit ~ '^[0-9a-f]{40}$'),
  constraint mike_workflows_content_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists mike_workflows_active_key_idx
  on public.mike_workflows(workflow_key)
  where active;

create index if not exists mike_workflows_active_distribution_type_idx
  on public.mike_workflows(active, distribution, type, title);

create index if not exists mike_workflows_active_pack_idx
  on public.mike_workflows(active, pack_key, title);

create table if not exists public.mike_workflow_reference_files (
  id uuid primary key default gen_random_uuid(),
  mike_workflow_id uuid not null
    references public.mike_workflows(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint mike_workflow_reference_files_name_unique
    unique(mike_workflow_id, filename),
  constraint mike_workflow_reference_files_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

-- Preserve catalog rows and uploaded references created by the former lazy
-- add-on synchronizer. The old tables remain in place for rollback; the
-- application stops reading and writing them after this migration.
do $$
begin
  if to_regclass('public.workflow_addons') is not null then
    execute $backfill$
      insert into public.mike_workflows (
        workflow_key, distribution, version, title, description, type,
        prompt_md, columns_config, contributors, language, practice,
        jurisdictions, pack_key, pack_title, pack_description, pack_version,
        content_hash, active, created_at, updated_at
      )
      select
        addon_key, 'addon', version, title, description, type,
        prompt_md, columns_config, contributors, language, practice,
        jurisdictions, pack_key, pack_title, pack_description, pack_version,
        content_hash, false, created_at, updated_at
      from public.workflow_addons
      on conflict (workflow_key, content_hash) do nothing
    $backfill$;
  end if;

  if to_regclass('public.workflow_addon_reference_files') is not null
     and to_regclass('public.workflow_addons') is not null then
    execute $references$
      insert into public.mike_workflow_reference_files (
        mike_workflow_id, filename, file_type, storage_path,
        size_bytes, content_hash, created_at
      )
      select
        catalog.id, reference.filename, reference.file_type,
        reference.storage_path, reference.size_bytes,
        reference.content_hash, reference.created_at
      from public.workflow_addon_reference_files reference
      join public.workflow_addons addon on addon.id = reference.addon_id
      join public.mike_workflows catalog
        on catalog.workflow_key = addon.addon_key
       and catalog.content_hash = addon.content_hash
      on conflict (mike_workflow_id, filename) do nothing
    $references$;
  end if;
end;
$$;

-- Replace the active catalog as one transaction. Content-addressed historical
-- rows remain available for old builtin-* workflow references.
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
  reference_item jsonb;
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

    delete from public.mike_workflow_reference_files
    where mike_workflow_id = workflow_uuid;

    if item ? 'reference_files' then
      if jsonb_typeof(item->'reference_files') <> 'array' then
        raise exception 'workflow reference_files must be an array';
      end if;
      for reference_item in
        select value from jsonb_array_elements(item->'reference_files')
      loop
        insert into public.mike_workflow_reference_files (
          mike_workflow_id, filename, file_type, storage_path,
          size_bytes, content_hash
        ) values (
          workflow_uuid,
          reference_item->>'filename',
          reference_item->>'file_type',
          reference_item->>'storage_path',
          nullif(reference_item->>'size_bytes', '')::integer,
          reference_item->>'content_hash'
        );
      end loop;
    end if;
  end loop;
end;
$$;

-- Default definitions now come directly from the shared catalog. Installed
-- workflows remain independent user-owned copies, and installation markers
-- continue to prevent a deleted default from being silently recreated.
create or replace function public.install_missing_default_workflows(
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  catalog_item public.mike_workflows%rowtype;
  workflow_uuid uuid;
  installed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for catalog_item in
    select catalog.*
    from public.mike_workflows catalog
    where catalog.active
      and catalog.distribution = 'default'
    order by catalog.default_sort_order nulls last, catalog.workflow_key
  loop
    if exists (
      select 1
      from public.default_workflow_installations installation
      where installation.user_id::text = p_user_id
        and installation.default_key = catalog_item.workflow_key
    ) then
      continue;
    end if;

    insert into public.workflows (
      user_id, title, type, prompt_md, columns_config,
      language, practice, jurisdictions
    ) values (
      p_user_id::uuid,
      catalog_item.title,
      catalog_item.type,
      catalog_item.prompt_md,
      catalog_item.columns_config,
      coalesce(nullif(catalog_item.language, ''), 'English'),
      coalesce(nullif(catalog_item.practice, ''), 'General Transactions'),
      coalesce(catalog_item.jurisdictions, array['General']::text[])
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id, default_key, workflow_id
    ) values (
      p_user_id::uuid, catalog_item.workflow_key, workflow_uuid
    );

    if catalog_item.type = 'assistant'
       and catalog_item.quick_action_name is not null then
      insert into public.quick_actions (
        user_id, workflow_id, name, prompt, document_upload,
        enabled, sort_order, surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        catalog_item.quick_action_name,
        coalesce(catalog_item.quick_action_prompt, ''),
        catalog_item.document_upload,
        true,
        coalesce(catalog_item.default_sort_order, installed_count),
        'app'
      );

      if catalog_item.word_quick_action then
        insert into public.quick_actions (
          user_id, workflow_id, name, prompt, document_upload,
          enabled, sort_order, surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          catalog_item.quick_action_name,
          coalesce(
            catalog_item.word_quick_action_prompt,
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce(catalog_item.default_sort_order, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

revoke all on public.mike_workflows from anon, authenticated;
revoke all on public.mike_workflow_reference_files from anon, authenticated;
revoke all on function public.replace_mike_workflows(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.install_missing_default_workflows(text)
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.mike_workflows,
     public.mike_workflow_reference_files
  to service_role;

grant execute
  on function public.replace_mike_workflows(text, jsonb)
  to service_role;

grant execute
  on function public.install_missing_default_workflows(text)
  to service_role;
