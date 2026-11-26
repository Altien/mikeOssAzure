-- Migration date: 2026-10-30
-- Upstream divergence (sync-log: 4dd610d3): upstream's uuid actor/user ids
-- keep Dev's text types from 0134 (audit_events.user_id and the returned
-- user_id are text; p_actor_id is the text session user id), so the
-- signature and grants of 0134 are unchanged. The recursive seek walks the
-- same 0134 (org_id, user_id, created_at desc, id desc) index.
create or replace function public.organization_audit_actors(
  p_org_id uuid, p_actor_id text, p_search text default '',
  p_offset integer default 0, p_limit integer default 21
)
returns table(user_id text, email text, display_name text, profile_photo text)
language sql stable set search_path = public, pg_temp as $$
  -- Seek to the next distinct actor using the leading (org_id,user_id)
  -- index columns. DISTINCT ON would read every historical event first.
  with recursive actors as (
    (select a.user_id, a.user_email
     from public.audit_events a
     where a.org_id=p_org_id and a.user_id is not null and exists (
       select 1 from public.active_org_members m
       where m.org_id=p_org_id and m.user_id::text=p_actor_id and m.role in ('owner','admin')
     )
     order by a.user_id,a.created_at desc,a.id desc limit 1)
    union all
    select next_actor.user_id,next_actor.user_email
    from actors previous
    cross join lateral (
      select a.user_id,a.user_email from public.audit_events a
      where a.org_id=p_org_id and a.user_id>previous.user_id
      order by a.user_id,a.created_at desc,a.id desc limit 1
    ) next_actor
  ), identities as (
    select a.user_id, coalesce(nullif(btrim(p.email), ''), a.user_email) as email,
      nullif(btrim(p.display_name), '') as display_name, p.profile_photo,
      a.user_email as recorded_email
    from actors a left join public.user_profiles p on p.user_id::text = a.user_id
  )
  select i.user_id, i.email, i.display_name, i.profile_photo from identities i
  where strpos(lower(coalesce(i.display_name, '')), lower(left(coalesce(p_search, ''), 200))) > 0
    or strpos(lower(coalesce(i.email, '')), lower(left(coalesce(p_search, ''), 200))) > 0
    or strpos(lower(coalesce(i.recorded_email, '')), lower(left(coalesce(p_search, ''), 200))) > 0
  order by lower(coalesce(i.display_name, i.email, i.user_id::text)), i.user_id
  limit greatest(0, least(coalesce(p_limit, 21), 51))
  offset greatest(0, coalesce(p_offset, 0));
$$;

notify pgrst, 'reload schema';
