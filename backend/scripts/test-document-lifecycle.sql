-- Run on a disposable Dev PostgreSQL database after all numbered migrations.
-- The caller must enforce a loopback/disposable database; this transaction
-- rolls back every synthetic row and never touches the production store.
\set ON_ERROR_STOP on
begin;
do $$
declare
  actor text := 'entra|tenant|lifecycle-test';
  doc uuid := gen_random_uuid();
  first_version uuid := gen_random_uuid();
  second_version uuid := gen_random_uuid();
  result jsonb;
begin
  insert into public.documents(id, user_id, status)
  values (doc, actor, 'ready');

  result := public.create_document_version(doc, jsonb_build_object(
    'id', first_version, 'filename', 'one.pdf', 'file_type', 'pdf',
    'source', 'user_upload', 'version_number', 1,
    'storage_path', 'lifecycle-test/one.pdf'));
  assert result->>'id' = first_version::text, 'first version was not created';
  result := public.create_document_version(doc, jsonb_build_object(
    'id', second_version, 'filename', 'two.pdf', 'file_type', 'pdf',
    'source', 'user_upload', 'storage_path', 'lifecycle-test/two.pdf'));
  assert (result->>'version_number')::integer = 2, 'version allocation';
  assert (select current_version_id = second_version from public.documents where id = doc),
    'new version was not activated atomically';

  perform public.create_document_version(doc, jsonb_build_object(
    'id', first_version, 'filename', 'stale-retry.pdf'));
  assert (select current_version_id = second_version from public.documents where id = doc),
    'stale retry reactivated an old version';
  assert (select filename = 'one.pdf' from public.document_versions where id = first_version),
    'stale retry overwrote metadata';

  result := public.delete_document_version(doc, first_version, actor);
  assert result->>'deleted_version_id' = first_version::text, 'version was not deleted';
  assert (select deleted_by = actor from public.document_versions where id = first_version),
    'text actor identity was not recorded';
  assert exists (
    select 1 from public.db_jobs where kind = 'document.cleanup'
      and payload->>'versionId' = first_version::text
      and payload->'keys' @> '["lifecycle-test/one.pdf"]'::jsonb
  ), 'cleanup intent was not written with the version transaction';

  assert has_function_privilege('service_role',
    'public.delete_document_version(uuid,uuid,text)', 'EXECUTE'), 'service grant';
  assert not has_function_privilege('web_anon',
    'public.delete_document_version(uuid,uuid,text)', 'EXECUTE'), 'web_anon must not write';
  assert not has_function_privilege('authenticated',
    'public.delete_document_version(uuid,uuid,text)', 'EXECUTE'), 'authenticated must not write';
end;
$$;
rollback;
\echo Dev document lifecycle transaction checks passed.
