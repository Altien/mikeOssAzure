-- Migration date: 2026-08-13
--
-- Enforce issue #104's missing auth.users referential integrity across every
-- application-owned user identifier. RPC parameters and return columns remain
-- text for API compatibility; their SQL bodies cast at the database boundary.

begin;

-- Refuse to reinterpret malformed identifiers. Orphaned, well-formed UUIDs are
-- rejected below when the foreign keys are validated.
do $$
declare
  target record;
  invalid_count bigint;
begin
  for target in
    select *
    from (values
      ('projects', 'user_id'),
      ('project_subfolders', 'user_id'),
      ('library_folders', 'user_id'),
      ('documents', 'user_id'),
      ('workflows', 'user_id'),
      ('hidden_workflows', 'user_id'),
      ('workflow_shares', 'shared_by_user_id'),
      ('default_workflow_installations', 'user_id'),
      ('quick_actions', 'user_id'),
      ('workflow_reference_documents', 'user_id'),
      ('workflow_open_source_submissions', 'submitted_by_user_id'),
      ('chats', 'user_id'),
      ('word_documents', 'user_id'),
      ('word_chats', 'user_id'),
      ('tabular_reviews', 'user_id'),
      ('tabular_review_chats', 'user_id')
    ) as columns_to_convert(table_name, column_name)
  loop
    execute format(
      'select count(*) from public.%I where %I is not null and %I !~* %L',
      target.table_name,
      target.column_name,
      target.column_name,
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) into invalid_count;

    if invalid_count > 0 then
      raise exception
        'Cannot convert %.% to uuid: % malformed value(s)',
        target.table_name,
        target.column_name,
        invalid_count;
    end if;
  end loop;
end
$$;

alter table public.projects
  alter column user_id type uuid using user_id::uuid;
alter table public.project_subfolders
  alter column user_id type uuid using user_id::uuid;
alter table public.library_folders
  alter column user_id type uuid using user_id::uuid;
alter table public.documents
  alter column user_id type uuid using user_id::uuid;
alter table public.workflows
  alter column user_id type uuid using user_id::uuid;
alter table public.hidden_workflows
  alter column user_id type uuid using user_id::uuid;
alter table public.workflow_shares
  alter column shared_by_user_id type uuid using shared_by_user_id::uuid;
alter table public.default_workflow_installations
  alter column user_id type uuid using user_id::uuid;
alter table public.quick_actions
  alter column user_id type uuid using user_id::uuid;
alter table public.workflow_reference_documents
  alter column user_id type uuid using user_id::uuid;
alter table public.workflow_open_source_submissions
  alter column submitted_by_user_id type uuid using submitted_by_user_id::uuid;
alter table public.chats
  alter column user_id type uuid using user_id::uuid;
alter table public.word_documents
  alter column user_id type uuid using user_id::uuid;
alter table public.word_chats
  alter column user_id type uuid using user_id::uuid;
alter table public.tabular_reviews
  alter column user_id type uuid using user_id::uuid;
alter table public.tabular_review_chats
  alter column user_id type uuid using user_id::uuid;

-- NOT VALID separates installation from verification, so an orphan identifies
-- the exact relationship that must be repaired without partially committing.
alter table public.projects
  add constraint projects_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.project_subfolders
  add constraint project_subfolders_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.library_folders
  add constraint library_folders_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.documents
  add constraint documents_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.document_versions
  add constraint document_versions_deleted_by_fkey
  foreign key (deleted_by) references auth.users(id) on delete set null not valid;
alter table public.workflows
  add constraint workflows_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.hidden_workflows
  add constraint hidden_workflows_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.workflow_shares
  add constraint workflow_shares_shared_by_user_id_fkey
  foreign key (shared_by_user_id) references auth.users(id) on delete cascade not valid;
alter table public.default_workflow_installations
  add constraint default_workflow_installations_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.quick_actions
  add constraint quick_actions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.workflow_reference_documents
  add constraint workflow_reference_documents_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.workflow_open_source_submissions
  add constraint workflow_open_source_submissions_submitted_by_user_id_fkey
  foreign key (submitted_by_user_id) references auth.users(id) on delete cascade not valid;
alter table public.chats
  add constraint chats_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.word_documents
  add constraint word_documents_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.word_chats
  add constraint word_chats_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.tabular_reviews
  add constraint tabular_reviews_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.tabular_review_chats
  add constraint tabular_review_chats_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;
alter table public.audit_events
  add constraint audit_events_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade not valid;

alter table public.projects validate constraint projects_user_id_fkey;
alter table public.project_subfolders validate constraint project_subfolders_user_id_fkey;
alter table public.library_folders validate constraint library_folders_user_id_fkey;
alter table public.documents validate constraint documents_user_id_fkey;
alter table public.document_versions validate constraint document_versions_deleted_by_fkey;
alter table public.workflows validate constraint workflows_user_id_fkey;
alter table public.hidden_workflows validate constraint hidden_workflows_user_id_fkey;
alter table public.workflow_shares validate constraint workflow_shares_shared_by_user_id_fkey;
alter table public.default_workflow_installations validate constraint default_workflow_installations_user_id_fkey;
alter table public.quick_actions validate constraint quick_actions_user_id_fkey;
alter table public.workflow_reference_documents validate constraint workflow_reference_documents_user_id_fkey;
alter table public.workflow_open_source_submissions validate constraint workflow_open_source_submissions_submitted_by_user_id_fkey;
alter table public.chats validate constraint chats_user_id_fkey;
alter table public.word_documents validate constraint word_documents_user_id_fkey;
alter table public.word_chats validate constraint word_chats_user_id_fkey;
alter table public.tabular_reviews validate constraint tabular_reviews_user_id_fkey;
alter table public.tabular_review_chats validate constraint tabular_review_chats_user_id_fkey;
alter table public.audit_events validate constraint audit_events_user_id_fkey;

-- Recompile RPCs that expose text user IDs while the storage columns are UUID.
create or replace function public.install_missing_default_workflows(
  p_user_id text,
  p_defaults jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  workflow_uuid uuid;
  installed_count integer := 0;
  jurisdiction_values text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for item in select value from jsonb_array_elements(coalesce(p_defaults, '[]'::jsonb))
  loop
    if nullif(trim(item->>'default_key'), '') is null then
      continue;
    end if;

    if exists (
      select 1
      from public.default_workflow_installations dwi
      where dwi.user_id::text = p_user_id
        and dwi.default_key = item->>'default_key'
    ) then
      continue;
    end if;

    select coalesce(array_agg(value), array['General']::text[])
      into jurisdiction_values
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(item->'jurisdictions') = 'array'
          then item->'jurisdictions'
        else '["General"]'::jsonb
      end
    );

    insert into public.workflows (
      user_id,
      title,
      type,
      prompt_md,
      columns_config,
      language,
      practice,
      jurisdictions
    ) values (
      p_user_id::uuid,
      item->>'title',
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case
        when jsonb_typeof(item->'columns_config') = 'array'
          then item->'columns_config'
        else null
      end,
      coalesce(nullif(item->>'language', ''), 'English'),
      coalesce(nullif(item->>'practice', ''), 'General Transactions'),
      jurisdiction_values
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id,
      default_key,
      workflow_id
    ) values (
      p_user_id::uuid,
      item->>'default_key',
      workflow_uuid
    );

    insert into public.quick_actions (
      user_id,
      workflow_id,
      prompt,
      document_upload,
      enabled,
      sort_order
    ) values (
      p_user_id::uuid,
      workflow_uuid,
      coalesce(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      true,
      coalesce((item->>'sort_order')::integer, installed_count)
    );

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       p.id is not null
       and p.user_id::text = p_user_id
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and (
        tr.user_id::text = p_user_id
        or (
          tr.project_id in (select ap.id from accessible_projects ap)
          and tr.user_id::text <> p_user_id
        )
        or (
          p_project_id is null
          and coalesce(p_user_email, '') <> ''
          and tr.user_id::text <> p_user_id
          and tr.shared_with @> jsonb_build_array(p_user_email)
        )
      )
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.shared_with,
    vr.created_at,
    vr.updated_at,
    vr.user_id::text = p_user_id as is_owner,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case
      when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, ''))
      else null
    end asc,
    case
      when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, ''))
      else null
    end desc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end asc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end desc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count
      else null
    end asc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count
      else null
    end desc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at
      else null
    end asc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at
      else null
    end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text default null,
  p_project_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id,
    p_user_email,
    p_project_id,
    'all',
    2147483647,
    0,
    null,
    'created',
    'desc'
  );
$$;

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  )
  select tr.id, tr.user_id::text as user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like
        '%' ||
        replace(
          replace(
            replace(lower(p_search_term), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) ||
        '%'
        escape '\'
    )
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and (
      tr.user_id::text = p_user_id
      or (
        tr.project_id in (select ap.id from accessible_projects ap)
        and tr.user_id::text <> p_user_id
      )
      or (
        p_project_id is null
        and coalesce(p_user_email, '') <> ''
        and tr.user_id::text <> p_user_id
        and tr.shared_with @> jsonb_build_array(p_user_email)
      )
    )
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc'
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text
)
returns table (file_types text[])
language sql
stable
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where p.user_id::text = p_user_id
       or (
         coalesce(p_user_email, '') <> ''
         and p.user_id::text <> p_user_id
         and p.shared_with @> jsonb_build_array(p_user_email)
       )
  ),
  distinct_owners as (
    select distinct vp.user_id
    from visible_projects vp
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where (
        p.user_id::text = p_user_id
        or (
          coalesce(p_user_email, '') <> ''
          and p.user_id::text <> p_user_id
          and p.shared_with @> jsonb_build_array(p_user_email)
        )
      )
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and p.user_id::text <> p_user_id)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select p.id, p.user_id::text as user_id
  from public.projects p
  where (
      p.user_id::text = p_user_id
      or (
        coalesce(p_user_email, '') <> ''
        and p.user_id::text <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
    )
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and p.user_id::text <> p_user_id)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(p.name, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.cm_number, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.practice, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or p.practice = p_practice)
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    p.user_id::text = p_user_id as is_owner
  from public.projects p
  where p.user_id::text = p_user_id
     or (
       coalesce(p_user_email, '') <> ''
       and p.user_id::text <> p_user_id
       and p.shared_with @> jsonb_build_array(p_user_email)
     )
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

commit;
