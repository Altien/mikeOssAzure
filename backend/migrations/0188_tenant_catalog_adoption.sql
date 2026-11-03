-- Multi-tenant 020: a member moving to another tenant may install the same
-- defaults again. The old tenant's invisible marker must not conflict.
alter table public.default_workflow_installations
  drop constraint default_workflow_installations_user_key_unique;
alter table public.default_workflow_installations
  add constraint default_workflow_installations_tenant_user_key_unique
  unique(tenant_id, user_id, default_key);

-- Existing tenant_definer ownership and function grants survive replacement.
-- RLS scopes the marker check; the advisory lock is now tenant-scoped too.
create or replace function public.install_missing_default_workflows(
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  catalog_item public.mike_workflows%rowtype;
  workflow_uuid uuid;
  installed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(app.current_tenant_id() || ':' || p_user_id, 0));

  for catalog_item in
    select catalog.*
    from public.mike_workflows catalog
    where catalog.active
      and catalog.distribution = 'default'
    order by catalog.default_sort_order nulls last, catalog.workflow_key
  loop
    if exists (
      select 1
      from public.default_workflow_installations installation
      where installation.user_id = p_user_id
        and installation.default_key = catalog_item.workflow_key
    ) then
      continue;
    end if;

    insert into public.workflows (
      user_id, title, type, prompt_md, columns_config,
      language, practice, jurisdictions
    ) values (
      p_user_id,
      catalog_item.title,
      catalog_item.type,
      catalog_item.prompt_md,
      catalog_item.columns_config,
      coalesce(nullif(catalog_item.language, ''), 'English'),
      coalesce(nullif(catalog_item.practice, ''), 'General Transactions'),
      coalesce(catalog_item.jurisdictions, array['General']::text[])
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id, default_key, workflow_id
    ) values (
      p_user_id, catalog_item.workflow_key, workflow_uuid
    );

    if catalog_item.type = 'assistant'
       and catalog_item.quick_action_name is not null then
      insert into public.quick_actions (
        user_id, workflow_id, name, prompt, document_upload,
        enabled, sort_order, surface
      ) values (
        p_user_id,
        workflow_uuid,
        catalog_item.quick_action_name,
        coalesce(catalog_item.quick_action_prompt, ''),
        catalog_item.document_upload,
        true,
        coalesce(catalog_item.default_sort_order, installed_count),
        'app'
      );

      if catalog_item.word_quick_action then
        insert into public.quick_actions (
          user_id, workflow_id, name, prompt, document_upload,
          enabled, sort_order, surface
        ) values (
          p_user_id,
          workflow_uuid,
          catalog_item.quick_action_name,
          coalesce(
            catalog_item.word_quick_action_prompt,
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce(catalog_item.default_sort_order, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;


revoke all on function public.install_missing_default_workflows(text) from public, web_anon, authenticated;
grant execute on function public.install_missing_default_workflows(text) to tenant_app, service_role;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 020: tenant RLS gaps: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
