-- Migration date: 2026-08-14
--
-- Normalize legacy project-sharing emails so indexed JSONB containment remains
-- reliable regardless of how an invitation was capitalized when it was stored.
-- Current POST/PATCH routes already enforce this representation for new writes.

with normalized_projects as (
  select
    p.id,
    coalesce(
      jsonb_agg(entries.email order by entries.first_position)
        filter (where entries.email is not null),
      '[]'::jsonb
    ) as shared_with
  from public.projects p
  left join lateral (
    select
      lower(trim(raw.value)) as email,
      min(raw.position) as first_position
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(p.shared_with) = 'array' then p.shared_with
        else '[]'::jsonb
      end
    ) with ordinality as raw(value, position)
    where trim(raw.value) <> ''
    group by lower(trim(raw.value))
  ) entries on true
  group by p.id
)
update public.projects p
set shared_with = normalized_projects.shared_with
from normalized_projects
where p.id = normalized_projects.id
  and p.shared_with is distinct from normalized_projects.shared_with;
