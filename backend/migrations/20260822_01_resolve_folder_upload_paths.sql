-- Resolve uploaded folder paths against the complete server-side hierarchy.
-- Advisory transaction locks serialize path creation within one project or
-- one user library so two concurrent folder uploads cannot create the same
-- path. Existing top-level folders are reported to the caller before any
-- mutation so the UI can ask whether to delete and replace them or create a
-- suffixed copy. The `reuse` mode is reserved for nested segments after that
-- top-level choice has already been made.

create or replace function public.resolve_project_folder_path(
  target_project_id uuid,
  target_user_id uuid,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.project_subfolders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.project_subfolders
    where id = base_folder_id and project_id = target_project_id
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-folder-path:' || target_project_id::text, 0)
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.project_subfolders
    where project_id = target_project_id
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.project_subfolders
          where project_id = target_project_id
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.project_subfolders (
        project_id, user_id, name, parent_folder_id
      ) values (
        target_project_id, target_user_id, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

create or replace function public.resolve_library_folder_path(
  target_user_id uuid,
  target_library_kind text,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.library_folders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if target_library_kind not in ('file', 'template') then
    raise exception 'Invalid library kind';
  end if;
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.library_folders
    where id = base_folder_id
      and user_id = target_user_id
      and library_kind = target_library_kind
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'library-folder-path:' || target_user_id::text || ':' || target_library_kind,
      0
    )
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.library_folders
    where user_id = target_user_id
      and library_kind = target_library_kind
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.library_folders
          where user_id = target_user_id
            and library_kind = target_library_kind
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.library_folders (
        user_id, library_kind, name, parent_folder_id
      ) values (
        target_user_id, target_library_kind, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

revoke all on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  to service_role;

revoke all on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  to service_role;
