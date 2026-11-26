-- Migration date: 2026-11-01
-- Upstream divergence (sync-log: 5f326a58): upstream's
-- 20261101_02_foreign_key_indexes.sql builds these online (non-blocking)
-- outside a transaction, with an INVALID-index guard. Dev's numbered SQL
-- runner (src/scripts/migrationLedger.ts) runs every file in a transaction
-- and rejects nontransactional SQL, so Dev builds them in this file's
-- transaction (SHARE lock for the build only). A transactional build that
-- fails rolls back and cannot leave an INVALID index, so the guard is
-- omitted. Large deployments should pre-build them online out of band;
-- if not exists then makes this file a no-op.
-- Dev's foreign keys are composite (tenant_id, <column>); the cascade's
-- "<column> = $2" is still answered by an index led by <column>.
-- Every ON DELETE CASCADE / SET NULL runs "where <child column> = <deleted
-- parent id>" once per deleted parent row. Without an index led by that
-- column each one scans the whole child table across every tenant. Nullable
-- columns are indexed only where set: the cascade's equality implies it.
create index if not exists tabular_cells_row_idx
  on public.tabular_cells(row_id);
create index if not exists tabular_cells_document_idx
  on public.tabular_cells(document_id);
create index if not exists tabular_review_rows_document_idx
  on public.tabular_review_rows(document_id) where document_id is not null;
create index if not exists tabular_review_rows_folder_idx
  on public.tabular_review_rows(folder_id) where folder_id is not null;
create index if not exists tabular_review_rows_library_folder_idx
  on public.tabular_review_rows(library_folder_id) where library_folder_id is not null;
create index if not exists documents_current_version_idx
  on public.documents(current_version_id) where current_version_id is not null;
create index if not exists documents_folder_idx
  on public.documents(folder_id) where folder_id is not null;
create index if not exists documents_library_folder_idx
  on public.documents(library_folder_id) where library_folder_id is not null;
create index if not exists playbook_runs_edited_version_idx
  on public.playbook_runs(edited_version_id) where edited_version_id is not null;
create index if not exists tabular_reviews_workflow_idx
  on public.tabular_reviews(workflow_id) where workflow_id is not null;
create index if not exists project_subfolders_parent_idx
  on public.project_subfolders(parent_folder_id) where parent_folder_id is not null;
-- clear_org_private_item_access deletes "where kind=<item kind> and
-- item_id=<deleted item>" on every delete/move/archive of a project,
-- workflow, chat, review or document. Neither existing index leads with it.
create index if not exists org_private_content_access_item_idx
  on public.org_private_content_access(kind,item_id);
