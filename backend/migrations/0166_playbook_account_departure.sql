-- Source180: preserve organization-public Playbooks inside the canonical departure transaction.
create or replace function public.prepare_account_org_departures(p_user_id text)
returns void language plpgsql set search_path = public as $$
declare membership record; successor text;
begin
  -- Lock all organizations in a fixed order before changing any of them.
  perform o.id from public.organizations o join public.org_members m on m.org_id=o.id
    where m.user_id::text=p_user_id and o.kind='team' order by o.id for update of o;
  for membership in select m.org_id from public.org_members m join public.organizations o on o.id=m.org_id
    where m.user_id::text=p_user_id and o.kind='team' order by m.org_id loop
    successor:=public.org_default_departure_successor(membership.org_id,array[p_user_id]);
    if successor is not null then
      update public.playbooks set user_id=successor,updated_at=clock_timestamp()
        where org_id=membership.org_id and user_id=p_user_id and visibility='organization';
    end if;
    perform public.remove_org_member(membership.org_id,p_user_id,p_user_id,null);
  end loop;
end;
$$;
revoke all on function public.prepare_account_org_departures(text) from public,web_anon,authenticated;
grant execute on function public.prepare_account_org_departures(text) to service_role;
notify pgrst,'reload schema';
