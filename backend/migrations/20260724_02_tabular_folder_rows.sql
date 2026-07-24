-- Support one tabular-review row per project folder, with multiple source documents.
alter table public.tabular_reviews
  add column if not exists document_grouping text not null default 'document'
  check (document_grouping in ('document', 'folder'));

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);
alter table public.tabular_review_rows enable row level security;

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
insert into public.tabular_review_rows (review_id, label, row_type, document_id, sort_index)
select distinct on (cell.review_id, cell.document_id)
  cell.review_id,
  coalesce(document.filename, 'Untitled document'),
  'document',
  cell.document_id,
  row_number() over (partition by cell.review_id order by cell.document_id) - 1
from public.tabular_cells cell
join public.documents document on document.id = cell.document_id
where cell.row_id is null
  and not exists (
    select 1 from public.tabular_review_rows row
    where row.review_id = cell.review_id and row.document_id = cell.document_id
  );

insert into public.tabular_review_row_sources (row_id, document_id)
select row.id, row.document_id
from public.tabular_review_rows row
where row.document_id is not null
on conflict (row_id, document_id) do nothing;

update public.tabular_cells cell
set row_id = row.id
from public.tabular_review_rows row
where cell.row_id is null
  and row.review_id = cell.review_id
  and row.document_id = cell.document_id;

revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;
