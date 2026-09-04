-- Migration date: 2026-09-04

-- Preserve the sharing state that exists on main, then remove the three
-- superseded storage shapes. This runs after the final grant tables and
-- workflow role column exist.
--
-- Project-contained chats and reviews now inherit access exclusively from
-- their project. Only standalone reviews can retain a resource-specific
-- direct grant without broadening access to the entire project.

begin;

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'shared_with'
  ) then
    execute $sql$
      insert into public.project_access_grants (
        project_id, email, role, created_by
      )
      select distinct
        project.id,
        lower(trim(recipient.email)),
        'editor',
        project.user_id
      from public.projects project
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(project.shared_with) = 'array'
            then project.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where trim(recipient.email) <> ''
        and position('@' in recipient.email) > 0
      on conflict (project_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tabular_reviews'
      and column_name = 'shared_with'
  ) then
    execute $sql$
      insert into public.tabular_review_access_grants (
        tabular_review_id, email, role, created_by
      )
      select distinct
        review.id,
        lower(trim(recipient.email)),
        'editor',
        review.user_id
      from public.tabular_reviews review
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(review.shared_with) = 'array'
            then review.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where review.project_id is null
        and trim(recipient.email) <> ''
        and position('@' in recipient.email) > 0
      on conflict (tabular_review_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflow_shares'
      and column_name = 'allow_edit'
  ) then
    execute $sql$
      update public.workflow_shares
      set role = case when allow_edit then 'editor' else 'viewer' end
    $sql$;
  end if;
end;
$migration$;

drop index if exists public.projects_shared_with_idx;
alter table public.projects drop column if exists shared_with;

drop index if exists public.tabular_reviews_shared_with_idx;
alter table public.tabular_reviews drop column if exists shared_with;

alter table public.workflow_shares drop column if exists allow_edit;

notify pgrst, 'reload schema';

commit;
