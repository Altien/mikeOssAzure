-- Run with psql -v ON_ERROR_STOP=1 against a migrated LOCAL test database.
-- Transactional fixtures only. No wall-clock performance assertion: the role
-- wrapper fails deterministically if the query inspects an unrelated tenant.
begin;
create function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception '%', message; end if;
end;
$$;

create temporary table chat_cases (id uuid primary key, label text);
create temporary table chat_actor (id uuid, email text, org_id uuid);
create temporary sequence role_calls minvalue 0 start 0;
do $$
declare
  caller uuid := gen_random_uuid();
  colleague uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  team uuid := gen_random_uuid();
  owned_project uuid := gen_random_uuid();
  shared_project uuid := gen_random_uuid();
  team_project uuid := gen_random_uuid();
  private_project uuid := gen_random_uuid();
  item uuid;
begin
  insert into auth.users(id,email) values
    (caller,caller||'@example.test'),
    (colleague,colleague||'@example.test'),
    (outsider,outsider||'@example.test');
  insert into organizations(id,name,created_by,kind)
    values(team,'Synthetic team',caller,'team');
  insert into org_members(org_id,user_id,role)
    values(team,caller,'owner'),(team,colleague,'member');
  insert into chat_actor values(caller,caller||'@example.test',team);
  insert into projects(id,user_id,org_id,name,visibility) values
    (owned_project,caller,null,'Owned','private'),
    (shared_project,outsider,null,'Shared','private'),
    (team_project,colleague,team,'Team','organization'),
    (private_project,colleague,team,'Private','private');
  insert into project_access_grants(project_id,email,role,created_by)
    values(shared_project,caller||'@example.test','viewer',outsider);

  -- 1,000 newer unrelated chats must not affect the caller's first page.
  insert into chats(user_id,title,updated_at)
    select outsider,'Unrelated',now()+interval '1 day'
    from generate_series(1,1000);
  insert into chats(user_id,title) values(caller,'Owned') returning id into item;
  insert into chat_cases values(item,'owned');
  insert into chats(user_id,title) values(outsider,'Direct grant') returning id into item;
  insert into chat_cases values(item,'direct');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','editor',outsider);
  insert into chats(user_id,project_id,title)
    values(outsider,owned_project,'Owned project') returning id into item;
  insert into chat_cases values(item,'owned-project');
  insert into chats(user_id,project_id,title)
    values(outsider,shared_project,'Shared project') returning id into item;
  insert into chat_cases values(item,'shared-project');
  insert into chats(user_id,project_id,title)
    values(colleague,team_project,'Team project') returning id into item;
  insert into chat_cases values(item,'team-project');
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Team direct grant') returning id into item;
  insert into chat_cases values(item,'team-direct');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','viewer',colleague);
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Private audited') returning id into item;
  insert into chat_cases values(item,'audited');
  perform open_org_private_content(team,caller,'chat',item);
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Private unopened') returning id into item;
  insert into chat_cases values(item,'private-hidden');
  insert into chats(user_id,project_id,title)
    values(colleague,private_project,'Private project unopened') returning id into item;
  insert into chat_cases values(item,'private-project-hidden');
  insert into chats(user_id,title,archived_at)
    values(caller,'Archived',now()) returning id into item;
  insert into chat_cases values(item,'archived-hidden');
  -- An active user must not pay a role check for every old chat just to
  -- read a two-row page, either.
  with added as (
    insert into chats(user_id,title) select caller,'More owned chats' from generate_series(1,200)
    returning id
  ) insert into chat_cases select id,'more-owned' from added;
end;
$$;

-- Compute the oracle from the canonical permission function, independently
-- of the candidate query, then instrument that function's call boundary.
create temporary table expected_chats as
select c.*, public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,a.id::text,a.email) as access_role
from chats c join chat_cases fixture on fixture.id=c.id cross join chat_actor a;
alter function public.chat_access_role(uuid,uuid,uuid,uuid,text,text)
  rename to sentry_test_chat_access_role;
create function public.chat_access_role(
  p_chat_id uuid,p_chat_user_id uuid,p_project_id uuid,p_org_id uuid,p_user_id text,p_user_email text
) returns text language plpgsql as $$
begin
  perform nextval('pg_temp.role_calls');
  if not exists(select 1 from pg_temp.chat_cases where id=p_chat_id) then
    raise exception 'Chat overview evaluated permissions for an unrelated tenant';
  end if;
  return public.sentry_test_chat_access_role(p_chat_id,p_chat_user_id,p_project_id,p_org_id,p_user_id,p_user_email);
end;
$$;

do $$
declare a record; workspace text; actual uuid[]; expected uuid[]; cursor_row record;
begin
  select * into a from chat_actor;
  foreach workspace in array array[null::text,'personal',a.org_id::text] loop
    select array_agg(id order by updated_at desc,id) into expected from expected_chats
      where access_role is not null and workspace_matches(workspace,org_id);
    select array_agg(id order by updated_at desc,id) into actual
      from get_chats_overview(a.id::text,a.email,null,0,null,null,workspace);
    perform pg_temp.assert_true(actual is not distinct from expected,'visibility/workspace parity');
  end loop;
  select array_agg(id order by updated_at desc,id) into expected from (
    select * from expected_chats where access_role is not null
    order by updated_at desc,id limit 2 offset 1
  ) page;
  perform setval('pg_temp.role_calls',0,false);
  select array_agg(id order by updated_at desc,id) into actual
    from get_chats_overview(a.id::text,a.email,2,1);
  perform pg_temp.assert_true(actual is not distinct from expected,'offset pagination parity');
  perform pg_temp.assert_true((select last_value<10 from pg_temp.role_calls),'small pages stop permission checks after enough visible rows');
  select * into cursor_row from expected_chats where access_role is not null
    order by updated_at desc,id limit 1 offset 1;
  select array_agg(id order by updated_at desc,id) into expected from expected_chats
    where access_role is not null and (updated_at<cursor_row.updated_at or (updated_at=cursor_row.updated_at and id>cursor_row.id));
  select array_agg(id order by updated_at desc,id) into actual
    from get_chats_overview(a.id::text,a.email,null,0,cursor_row.updated_at,cursor_row.id);
  perform pg_temp.assert_true(actual is not distinct from expected,'cursor pagination parity');
  perform pg_temp.assert_true((select count(*)=207 from expected_chats where access_role is not null),'fixture covers seven independent visible cases and an active user history');
  perform pg_temp.assert_true(not has_table_privilege('authenticated','chats','SELECT'),'browser still cannot read backend-owned chats');
end;
$$;
rollback;
