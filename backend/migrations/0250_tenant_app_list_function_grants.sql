-- Migration date: 2026-11-25
-- Restore tenant_app execute on functions the upstream batch 20261124
-- created or re-created. 0180 grants tenant_app execute on every public
-- function that is not platform or job control, but only on functions that
-- existed then; these migrations granted service_role only:
--   0208 org_private_content_item(uuid,text,uuid)      (sync 6d52372f)
--   0210 project_list_access(text,text,text)            (sync c9f47a1f)
--   0211 review_list_access(text,text,text,text)        (sync 4a55dd26)
--   0212 workflow_list_access(text,text,text)           (sync a9a146e9)
--   0217 search_project_directory(...)                  (sync 4de4c8d2)
--   0218 get_projects_overview(..., boolean)            (sync 3b981481)
--        dropped the 11-argument overload, which held tenant_app execute
--   0226 document_referencing_items(uuid)               (sync c18c1ccd)
--   0248 stamp_tabular_cell_revision()                  (sync e39639bc)
-- The request client runs as tenant_app, and the list RPCs are security
-- invoker, so project, review and workflow lists failed with "permission
-- denied for function". The grant matches 0180's policy for tenant functions.
grant execute on function public.org_private_content_item(uuid, text, uuid) to tenant_app;
grant execute on function public.project_list_access(text, text, text) to tenant_app;
grant execute on function public.review_list_access(text, text, text, text) to tenant_app;
grant execute on function public.workflow_list_access(text, text, text) to tenant_app;
grant execute on function public.search_project_directory(text, text, text, integer, integer, text) to tenant_app;
grant execute on function public.get_projects_overview(text, text, text, integer, integer, text, text, text, text, text, text, boolean) to tenant_app;
grant execute on function public.document_referencing_items(uuid) to tenant_app;
grant execute on function public.stamp_tabular_cell_revision() to tenant_app;

notify pgrst, 'reload schema';
