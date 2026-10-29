-- Forward counterpart of source63c83cc8 prerequisite diagnostics.
--0122 is immutable; the canonical runner supplies per-file transaction safety.
do $$
begin
  if to_regprocedure('public.memory_project_is_private(uuid)') is null
    or to_regprocedure('public.delete_user_private_memories(text)') is null
    or to_regprocedure('public.memory_source_allows_app_memory(text, uuid, text, uuid)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'This database is missing objects from 0092_memory_followup.sql',
      detail = 'A manually confirmed baseline may have recorded history without the corresponding objects. Canonical numbered history must reflect actual applied SQL.',
      hint = 'Inspect the missing numbered migration and recover it through the documented canonical migration process before retrying. Do not replay schema.sql or edit pgmigrations by hand.';
  end if;
end;
$$;
