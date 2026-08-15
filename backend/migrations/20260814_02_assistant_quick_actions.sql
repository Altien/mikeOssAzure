alter table public.user_profiles
  add column if not exists quick_actions_visible boolean not null default true;

alter table public.quick_actions
  add column if not exists name text;

update public.quick_actions qa
set name = coalesce(nullif(trim(qa.name), ''), w.title)
from public.workflows w
where qa.workflow_id = w.id
  and nullif(trim(qa.name), '') is null;

alter table public.quick_actions
  alter column name set not null;

-- Quick Actions launch the Assistant and therefore cannot target tabular
-- workflows. Remove legacy rows created for the former tabular default.
delete from public.quick_actions qa
using public.workflows w
where qa.workflow_id = w.id
  and w.type <> 'assistant';

create or replace function public.install_missing_default_workflows(
  p_user_id text,
  p_defaults jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  workflow_uuid uuid;
  installed_count integer := 0;
  jurisdiction_values text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for item in select value from jsonb_array_elements(coalesce(p_defaults, '[]'::jsonb))
  loop
    if nullif(trim(item->>'default_key'), '') is null then
      continue;
    end if;

    if exists (
      select 1
      from public.default_workflow_installations dwi
      where dwi.user_id::text = p_user_id
        and dwi.default_key = item->>'default_key'
    ) then
      continue;
    end if;

    select coalesce(array_agg(value), array['General']::text[])
      into jurisdiction_values
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(item->'jurisdictions') = 'array'
          then item->'jurisdictions'
        else '["General"]'::jsonb
      end
    );

    insert into public.workflows (
      user_id,
      title,
      type,
      prompt_md,
      columns_config,
      language,
      practice,
      jurisdictions
    ) values (
      p_user_id::uuid,
      item->>'title',
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case
        when jsonb_typeof(item->'columns_config') = 'array'
          then item->'columns_config'
        else null
      end,
      coalesce(nullif(item->>'language', ''), 'English'),
      coalesce(nullif(item->>'practice', ''), 'General Transactions'),
      jurisdiction_values
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id,
      default_key,
      workflow_id
    ) values (
      p_user_id::uuid,
      item->>'default_key',
      workflow_uuid
    );

    if item->>'type' = 'assistant' then
    insert into public.quick_actions (
      user_id,
      workflow_id,
      name,
      prompt,
      document_upload,
      enabled,
      sort_order
    ) values (
      p_user_id::uuid,
      workflow_uuid,
      coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
      coalesce(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      true,
      coalesce((item->>'sort_order')::integer, installed_count)
    );
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

revoke all on function public.install_missing_default_workflows(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.install_missing_default_workflows(text, jsonb)
  to service_role;
