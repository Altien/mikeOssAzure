-- Support one tabular-review row per project or library folder, with multiple source documents.
alter table public.tabular_reviews
  add column if not exists document_grouping text not null default 'document'
  check (document_grouping in ('document', 'folder'));

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_folder_id uuid references public.library_folders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);
alter table public.tabular_review_rows enable row level security;

alter table public.tabular_review_rows
  add column if not exists library_folder_id uuid
  references public.library_folders(id) on delete set null;

create table if not exists public.tabular_review_row_sources (
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  sort_index integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (row_id, document_id)
);
create index if not exists idx_tabular_review_row_sources_document
  on public.tabular_review_row_sources(document_id);
alter table public.tabular_review_row_sources enable row level security;

alter table public.tabular_cells
  add column if not exists row_id uuid references public.tabular_review_rows(id) on delete cascade;
alter table public.tabular_cells
  alter column document_id drop not null;
create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

-- Preserve every existing document row when upgrading an active database.
with document_rows as (
  select distinct cell.review_id, cell.document_id
  from public.tabular_cells cell
  join public.tabular_reviews review on review.id = cell.review_id
  where cell.row_id is null
    and review.document_grouping = 'document'
  union
  select review.id, source.document_id::uuid
  from public.tabular_reviews review
  cross join lateral jsonb_array_elements_text(
    coalesce(review.document_ids, '[]'::jsonb)
  ) source(document_id)
  join public.documents document on document.id = source.document_id::uuid
  where review.document_grouping = 'document'
    or (
      review.document_grouping = 'folder'
      and document.folder_id is null
      and document.library_folder_id is null
    )
)
insert into public.tabular_review_rows (review_id, label, row_type, document_id, sort_index)
select
  document_row.review_id,
  coalesce(nullif(btrim(active_version.filename), ''), 'Untitled document'),
  'document',
  document_row.document_id,
  (row_number() over (
    partition by document_row.review_id
    order by document_row.document_id
  ) - 1)::integer
from document_rows document_row
join public.documents document on document.id = document_row.document_id
left join lateral (
  select version.filename
  from public.document_versions version
  where version.document_id = document.id
    and version.deleted_at is null
  order by (version.id = document.current_version_id) desc, version.created_at desc
  limit 1
) active_version on true
where not exists (
    select 1 from public.tabular_review_rows row
    where row.review_id = document_row.review_id
      and row.document_id = document_row.document_id
  );

with folder_rows as (
  select distinct
    review.id as review_id,
    document.folder_id,
    coalesce(nullif(btrim(folder.name), ''), 'Unknown folder') as label
  from public.tabular_reviews review
  cross join lateral jsonb_array_elements_text(
    coalesce(review.document_ids, '[]'::jsonb)
  ) source(document_id)
  join public.documents document on document.id = source.document_id::uuid
  left join public.project_subfolders folder on folder.id = document.folder_id
  where review.document_grouping = 'folder'
    and review.project_id is not null
    and document.folder_id is not null
)
insert into public.tabular_review_rows (
  review_id,
  label,
  row_type,
  folder_id,
  sort_index
)
select
  folder_row.review_id,
  folder_row.label,
  'folder',
  folder_row.folder_id,
  row_number() over (
    partition by folder_row.review_id
    order by folder_row.label, folder_row.folder_id
  )::integer - 1
from folder_rows folder_row
where not exists (
  select 1
  from public.tabular_review_rows existing
  where existing.review_id = folder_row.review_id
    and existing.row_type = 'folder'
    and existing.folder_id = folder_row.folder_id
);

with library_folder_rows as (
  select distinct
    review.id as review_id,
    document.library_folder_id,
    coalesce(nullif(btrim(folder.name), ''), 'Unknown folder') as label
  from public.tabular_reviews review
  cross join lateral jsonb_array_elements_text(
    coalesce(review.document_ids, '[]'::jsonb)
  ) source(document_id)
  join public.documents document on document.id = source.document_id::uuid
  left join public.library_folders folder
    on folder.id = document.library_folder_id
  where review.document_grouping = 'folder'
    and document.library_folder_id is not null
)
insert into public.tabular_review_rows (
  review_id,
  label,
  row_type,
  library_folder_id,
  sort_index
)
select
  folder_row.review_id,
  folder_row.label,
  'folder',
  folder_row.library_folder_id,
  row_number() over (
    partition by folder_row.review_id
    order by folder_row.label, folder_row.library_folder_id
  )::integer - 1
from library_folder_rows folder_row
where not exists (
  select 1
  from public.tabular_review_rows existing
  where existing.review_id = folder_row.review_id
    and existing.row_type = 'folder'
    and existing.library_folder_id = folder_row.library_folder_id
);

insert into public.tabular_review_row_sources (row_id, document_id)
select row.id, row.document_id
from public.tabular_review_rows row
where row.document_id is not null
on conflict (row_id, document_id) do nothing;

insert into public.tabular_review_row_sources (row_id, document_id, sort_index)
select
  row.id,
  source.document_id::uuid,
  (source.ordinality - 1)::integer
from public.tabular_review_rows row
join public.tabular_reviews review on review.id = row.review_id
cross join lateral jsonb_array_elements_text(
  coalesce(review.document_ids, '[]'::jsonb)
) with ordinality source(document_id, ordinality)
join public.documents document on document.id = source.document_id::uuid
where row.row_type = 'folder'
  and (
    document.folder_id = row.folder_id
    or document.library_folder_id = row.library_folder_id
  )
on conflict (row_id, document_id) do nothing;

update public.tabular_cells cell
set row_id = row.id
from public.tabular_review_rows row
where cell.row_id is null
  and row.review_id = cell.review_id
  and row.document_id = cell.document_id;

insert into public.tabular_cells (
  review_id,
  row_id,
  document_id,
  column_index,
  status
)
select
  row.review_id,
  row.id,
  row.document_id,
  (column_config ->> 'index')::integer,
  'pending'
from public.tabular_review_rows row
join public.tabular_reviews review on review.id = row.review_id
cross join lateral jsonb_array_elements(
  coalesce(review.columns_config, '[]'::jsonb)
) column_config
where not exists (
  select 1
  from public.tabular_cells cell
  where cell.row_id = row.id
    and cell.column_index = (column_config ->> 'index')::integer
);

alter table public.tabular_cells
  alter column row_id set not null;

revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;

grant select, insert, update, delete on public.tabular_review_rows to service_role;
grant select, insert, update, delete on public.tabular_review_row_sources to service_role;
