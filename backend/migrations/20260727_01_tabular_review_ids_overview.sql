-- Migration date: 2026-07-27

-- Lightweight companion to get_tabular_reviews_overview for bulk "select
-- all matching" actions. A caller here only needs id + owning user, not a
-- full review payload — so this does NOT delegate to
-- get_tabular_reviews_overview: that RPC's cell_document_counts /
-- review_document_counts CTEs join and aggregate over tabular_cells for
-- every visible review just to compute document_count, which is pure waste
-- when the caller is going to discard everything but id/user_id anyway.
-- Instead this filters tabular_reviews directly with the same
-- visibility/scope/search predicate as the visible_reviews CTE there.
--
-- NOTE: that predicate is duplicated, not shared — SQL has no clean way to
-- factor a CTE across two function definitions. If the access/visibility
-- rules in get_tabular_reviews_overview's visible_reviews CTE ever change,
-- mirror the change here too.
--
-- Takes p_limit/p_offset (unlike a "give me everything" design) because
-- PostgREST enforces its own db-max-rows cap on every RPC response
-- regardless of what this function returns — a caller that doesn't page
-- through results will silently get a truncated set with no error. The
-- backend route pages through this on the caller's behalf.

drop function if exists public.get_tabular_review_ids_overview(
  text, text, text, text, text
);

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
  )
  select tr.id, tr.user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like '%' || lower(p_search_term) || '%'
    )
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and (
      tr.user_id = p_user_id
      or (
        tr.project_id in (select ap.id from accessible_projects ap)
        and tr.user_id <> p_user_id
      )
      or (
        p_project_id is null
        and coalesce(p_user_email, '') <> ''
        and tr.user_id <> p_user_id
        and tr.shared_with @> jsonb_build_array(p_user_email)
      )
    )
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
