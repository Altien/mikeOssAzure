-- Text documents written by the `write_project_document` chat tool.
--
-- The marker has to be its own source value rather than reusing 'generated':
-- the tool may only add versions to documents it wrote itself, and 'generated'
-- is already the whole generate_docx / generate_excel / generate_ppt family,
-- which it must refuse to take over.

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'external_retrieval'::text,
      'skill_import'::text,
      'tool_write'::text
    ]));
