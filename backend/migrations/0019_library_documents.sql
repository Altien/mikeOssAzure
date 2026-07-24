-- 0019_library_documents.sql
--
-- Adds the personal Library feature: a per-user document library ("files"
-- and "templates" kinds) with nestable folders, independent of any project.
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260710_01_library_documents.sql` (commit
-- f0b90ab3b44c4101d011d011dacafbe527833631, PR#215 "add library and refresh
-- shared table UI").
--
-- REQUIRED by the new `backend/src/routes/library.ts` route adopted in the
-- same sync: it reads/writes `library_folders` and the new `documents`
-- columns `library_kind` / `library_folder_id`, and lists project-less
-- documents partitioned by `library_kind`.
--
-- Divergence from upstream: the upstream migration ends with
--   `revoke all on public.library_folders from anon, authenticated;`
-- That statement targets Supabase's `anon` / `authenticated` PostgREST
-- roles, which do NOT exist on dev's Azure Postgres Flexible Server (dev
-- has no Supabase auth schema; access is enforced in `lib/access.ts` at the
-- application layer per KNOWLEDGE §2.1/§2.2). The revoke is therefore
-- dropped. `user_id` is a plain `text` column (no `auth.users` FK), matching
-- every other dev table.
--
-- Idempotent throughout (add column / create table / add constraint guarded
-- by IF NOT EXISTS or pg_constraint lookups). No column drops (KNOWLEDGE §4.3).

alter table public.documents
  add column if not exists library_kind text default 'file';

update public.documents
set library_kind = 'file'
where library_kind is null;

alter table public.documents
  alter column library_kind set default 'file',
  alter column library_kind set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_library_kind_check'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_library_kind_check
      check (library_kind in ('file', 'template'));
  end if;
end;
$$;

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

alter table public.documents
  add column if not exists library_folder_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_library_folder_id_fkey'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_library_folder_id_fkey
      foreign key (library_folder_id)
      references public.library_folders(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;
