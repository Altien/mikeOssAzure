-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: d305d060): upstream's
-- 20261101_16_folder_name_indexes.sql builds these online outside a
-- transaction with an INVALID-index guard. Dev's numbered SQL runner
-- (src/scripts/migrationLedger.ts) runs every file in a transaction and
-- rejects nontransactional SQL, so Dev builds them in this file's
-- transaction; a failed build rolls back, so the guard is omitted. Large
-- deployments should pre-build them online out of band; if not exists then
-- makes this file a no-op.
-- resolve_project_folder_path / resolve_library_folder_path look a sibling
-- up by its case- and space-insensitive name once per path segment, and
-- once per "(2)", "(3)" ... rename probe. With only (project_id) or
-- (user_id, library_kind) indexed, each lookup read every folder in the
-- project or library. Keyed by the normalized name, a lookup reads only
-- the folders of that name; the parent (matched with IS NOT DISTINCT FROM,
-- which no index can serve) and workspace are checked on those few rows.
create index if not exists project_subfolders_name_idx
  on public.project_subfolders(project_id,lower(btrim(name)));
create index if not exists library_folders_name_idx
  on public.library_folders(user_id,library_kind,lower(btrim(name)));
