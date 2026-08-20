alter table public.quick_actions
  add column if not exists surface text not null default 'app';

alter table public.quick_actions
  drop constraint if exists quick_actions_surface_check;

alter table public.quick_actions
  add constraint quick_actions_surface_check
  check (surface in ('app', 'word'));

create index if not exists quick_actions_user_surface_order_idx
  on public.quick_actions(user_id, surface, sort_order, created_at);

-- Existing Quick Actions belong to the web app. Seed independent Word actions
-- from the installed default workflows themselves, so users still receive the
-- Word defaults if they previously deleted an app Quick Action. Compare
-- Documents remains app-only because it requires multiple documents.
insert into public.quick_actions (
  user_id,
  workflow_id,
  name,
  prompt,
  document_upload,
  enabled,
  sort_order,
  surface
)
select
  dwi.user_id,
  dwi.workflow_id,
  coalesce(app_qa.name, w.title),
  'Execute this workflow on this Word document.',
  false,
  true,
  case dwi.default_key
    when 'proofread' then 0
    when 'extract-key-terms' then 1
    when 'draft-from-template' then 2
  end,
  'word'
from public.default_workflow_installations dwi
join public.workflows w
  on w.id = dwi.workflow_id
left join lateral (
  select qa.name
  from public.quick_actions qa
  where qa.user_id = dwi.user_id
    and qa.workflow_id = dwi.workflow_id
    and qa.surface = 'app'
  order by qa.created_at
  limit 1
) app_qa on true
where dwi.default_key in (
  'proofread',
  'extract-key-terms',
  'draft-from-template'
)
  and not exists (
    select 1
    from public.quick_actions word_qa
    where word_qa.user_id = dwi.user_id
      and word_qa.workflow_id = dwi.workflow_id
      and word_qa.surface = 'word'
  );

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
        sort_order,
        surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
        coalesce(item->>'quick_action_prompt', ''),
        coalesce((item->>'document_upload')::boolean, false),
        true,
        coalesce((item->>'sort_order')::integer, installed_count),
        'app'
      );

      if coalesce((item->>'word_quick_action')::boolean, false) then
        insert into public.quick_actions (
          user_id,
          workflow_id,
          name,
          prompt,
          document_upload,
          enabled,
          sort_order,
          surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
          coalesce(
            item->>'word_quick_action_prompt',
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce((item->>'sort_order')::integer, installed_count),
          'word'
        );
      end if;
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
