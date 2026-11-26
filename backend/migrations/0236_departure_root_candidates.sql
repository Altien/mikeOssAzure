-- Migration date: 2026-11-01
-- Upstream: 20261101_18_departure_root_candidates.sql (sync-log: 02de2ca5).
-- Dev: Dev's live org_members_departure_items (0226 body: text p_user_ids,
-- holder.user_id::text comparisons, reverse-reference retained_documents)
-- with only the four root FROM clauses changed. Upstream divergence: the
-- creator lookups compare Dev's text item.user_id to the text leaver id
-- directly; uuid-keyed overrides and user_profiles are probed with the
-- leaver id cast to uuid only when it is a well-formed lowercase uuid
-- (0221's idiom), so a non-uuid local id yields no co-owned candidate,
-- exactly as the unchanged holder.user_id::text test would reject it.
-- org_members_departure_items built its roots by reading every non-archived
-- item of each kind in the organization and testing each one with an OR
-- (created by a departing member, or an owner override/grant names one)
-- that PostgreSQL cannot turn into a join. Each root query now starts from
-- candidates: the departing members' own items (per-member creator lookup,
-- OFFSET 0 keeps it an index probe under the generic plan) and the items
-- they co-own through an owner override or grant. Every original condition,
-- including the OR, is unchanged, so candidates only narrow the scan.
create or replace function public.org_members_departure_items(p_org_id uuid, p_user_ids text[])
 RETURNS TABLE(kind text, item_id uuid, title text, disposition text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with roots as (
select 'project'::text kind,item.id item_id,
    case when item.visibility='organization' then item.name else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id::text = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.projects item where item.id in (
      -- Only items a departing member created or co-owns can be roots; the
      -- conditions below are evaluated for those, not every org project.
      -- Per departing member, a lookup by creator (user_id index); the
      -- organization is checked on the few rows found, never scanned.
      select p.id from unnest(p_user_ids) leaver(id)
        cross join lateral (select own.id,own.org_id from public.projects own where own.user_id=leaver.id offset 0) p
        where p.org_id=p_org_id
      union select g.project_id from unnest(p_user_ids) leaver(id) join public.project_org_access_overrides g on g.user_id=(case when leaver.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then leaver.id::uuid end)
        join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id
        where g.role='owner')
    and item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and holder.user_id::text = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id::text=item.user_id and not(m.user_id::text=any(p_user_ids)))
    and not exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and not (holder.user_id::text = any(p_user_ids)))
 union all
select 'workflow'::text kind,item.id item_id,
    case when item.visibility='organization' then item.title else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id::text = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.workflows item where item.id in (
      select w.id from unnest(p_user_ids) leaver(id)
        cross join lateral (select own.id,own.org_id from public.workflows own where own.user_id=leaver.id offset 0) w
        where w.org_id=p_org_id
      union select g.workflow_id from unnest(p_user_ids) leaver(id) join public.workflow_org_access_overrides g on g.user_id=(case when leaver.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then leaver.id::uuid end)
        join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id
        where g.role='owner')
    and item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and holder.user_id::text = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id::text=item.user_id and not(m.user_id::text=any(p_user_ids)))
    and not exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and not (holder.user_id::text = any(p_user_ids)))
 union all
select 'chat'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id::text = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.chats item where item.id in (
      select c.id from unnest(p_user_ids) leaver(id)
        cross join lateral (select own.id,own.org_id from public.chats own where own.user_id=leaver.id offset 0) c
        where c.org_id=p_org_id
      union select g.chat_id from unnest(p_user_ids) leaver(id) join public.user_profiles profile on profile.user_id=(case when leaver.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then leaver.id::uuid end)
        join public.chat_access_grants g on g.email=lower(profile.email)
        join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id
        where profile.email is not null and btrim(profile.email)<>'' and g.role='owner')
    and item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and holder.user_id::text = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id::text=item.user_id and not(m.user_id::text=any(p_user_ids)))
    and not exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and not (holder.user_id::text = any(p_user_ids)))
 union all
select 'tabular_review'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id::text = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.tabular_reviews item where item.id in (
      select r.id from unnest(p_user_ids) leaver(id)
        cross join lateral (select own.id,own.org_id from public.tabular_reviews own where own.user_id=leaver.id offset 0) r
        where r.org_id=p_org_id
      union select g.tabular_review_id from unnest(p_user_ids) leaver(id) join public.user_profiles profile on profile.user_id=(case when leaver.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then leaver.id::uuid end)
        join public.tabular_review_access_grants g on g.email=lower(profile.email)
        join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id
        where profile.email is not null and btrim(profile.email)<>'' and g.role='owner')
    and item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and holder.user_id::text = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id::text=item.user_id and not(m.user_id::text=any(p_user_ids)))
    and not exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email and profile.email is not null and btrim(profile.email)<>'' join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and not (holder.user_id::text = any(p_user_ids)))
  ), retained_documents as materialized (
    -- Start from the departing members' standalone documents (few) and look
    -- up who references each one, instead of expanding every chat message
    -- and review row in the organization. A reference counts when its chat
    -- or review is retained: live in this org, its project not archived, and
    -- neither it nor its project archived by this departure.
    select distinct d.id document_id
    from public.documents d
    cross join lateral public.document_referencing_items(d.id) ref
    left join public.chats c on ref.kind='chat' and c.id=ref.item_id
    left join public.tabular_reviews tr on ref.kind='tabular_review' and tr.id=ref.item_id
    where d.org_id=p_org_id and d.user_id=any(p_user_ids)
      and d.project_id is null and d.workflow_id is null and d.archived_at is null
      and case ref.kind when 'chat' then c.org_id=p_org_id and c.archived_at is null
        else tr.org_id=p_org_id and tr.archived_at is null end
      and not exists(select 1 from public.projects p where p.id=ref.project_id and p.archived_at is not null)
      and not exists(select 1 from roots r where r.kind=ref.kind and r.item_id=ref.item_id and r.disposition='archive')
      and (ref.project_id is null or not exists(select 1 from roots r where r.kind='project' and r.item_id=ref.project_id and r.disposition='archive'))
  ), documents as (
    select 'document'::text kind,d.id item_id,null::text title,
      case when d.id in (select document_id from retained_documents) then 'transfer' else 'archive' end disposition
    from public.documents d where d.org_id=p_org_id and d.user_id=any(p_user_ids)
      and d.project_id is null and d.workflow_id is null and d.archived_at is null
  ) select * from roots union all select * from documents;
$function$;
