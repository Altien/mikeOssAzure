-- 018: the only supported platform integration surface. Credentials are set
-- out of band (Key Vault); this migration deliberately contains no password.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='control_plane') then
    create role control_plane login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
do $$ begin
  if exists(select 1 from pg_roles where rolname='control_plane' and (rolsuper or rolbypassrls or rolreplication)) then
    raise exception 'Existing control_plane role has unsafe privileged attributes';
  end if;
end $$;
alter role control_plane login noinherit nocreatedb nocreaterole;
-- NOINHERIT alone still allows SET ROLE. Retain no role memberships at all.
do $$ declare r record; begin
  for r in select parent.rolname from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
    where m.member='control_plane'::regrole loop
    execute format('revoke %I from control_plane',r.rolname);
  end loop;
end $$;
revoke all on schema app from control_plane;
grant usage on schema public to control_plane;
alter table public.tenants add column stamp text,
  add column purged_at timestamptz;
alter table public.tenants drop constraint tenants_status_check,
  add constraint tenants_status_check check(status in ('active','pending','suspended','offboarding'));

-- Erasure follows the current tenant, even after a membership move.
alter table public.account_erasure_requests drop constraint account_erasure_requests_pkey,
  add primary key (tenant_id,user_id),
  add column usage_subject text not null default ('erased:' || gen_random_uuid()::text);
alter table public.account_erasure_storage_paths drop constraint account_erasure_storage_paths_pkey,
  add primary key (tenant_id,user_id,storage_path);
revoke insert,update,delete on public.account_erasure_requests from tenant_app;
grant select on public.account_erasure_requests to tenant_app;

-- The billing ledger stays append-only to request and platform roles. The
-- internal definer can change this one identity column only, via the trigger.
grant update(user_id) on public.llm_usage_events to tenant_definer;
create function app.usage_subject(p_tenant text,p_user text) returns text
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select coalesce((select usage_subject from public.account_erasure_requests
    where tenant_id=p_tenant and user_id=p_user),p_user)
$$;
create function app.pseudonymize_account_usage() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-usage:' || new.tenant_id,0));
  update public.llm_usage_events set user_id=new.usage_subject
    where tenant_id=new.tenant_id and user_id=new.user_id;
  update public.tenant_credit_reservations set user_id=new.usage_subject
    where tenant_id=new.tenant_id and user_id=new.user_id;
  update public.tenant_credit_periods set subject=new.usage_subject
    where tenant_id=new.tenant_id and subject=new.user_id and subject<>'';
  return new;
end $$;
create trigger pseudonymize_account_usage after insert or update of usage_subject
  on public.account_erasure_requests for each row execute function app.pseudonymize_account_usage();
create function app.protect_usage_identity() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-usage:' || new.tenant_id,0));
  if new.user_id is not null and new.user_id not like 'erased:%'
    and exists(select 1 from public.tenants where tenant_id=new.tenant_id and status='offboarding') then
    insert into public.account_erasure_requests(tenant_id,user_id,status,completed_at)
      values(new.tenant_id,new.user_id,'complete',now()) on conflict (tenant_id,user_id) do nothing;
  end if;
  new.user_id := app.usage_subject(new.tenant_id,new.user_id);
  return new;
end $$;
create trigger protect_usage_identity before insert on public.llm_usage_events
  for each row execute function app.protect_usage_identity();
do $$ declare v_had boolean:=has_schema_privilege('tenant_definer','app','CREATE'); begin
  grant create on schema app to tenant_definer;
  alter function app.usage_subject(text,text) owner to tenant_definer;
  alter function app.pseudonymize_account_usage() owner to tenant_definer;
  alter function app.protect_usage_identity() owner to tenant_definer;
  if not v_had then revoke create on schema app from tenant_definer; end if;
end $$;
revoke all on function app.usage_subject(text,text),app.pseudonymize_account_usage(),app.protect_usage_identity()
  from public,web_anon,authenticated,tenant_app,service_role;
grant execute on function app.usage_subject(text,text) to tenant_definer;

-- Preserve 016's decimal arithmetic, holds, price version and caller checks.
-- Every credit transaction takes the same lock before any row lock. A late
-- settlement authorises the original identity through its tenant tombstone.
do $$ declare v_signature text; v_definition text; v_claim text:=$claim$nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','')$claim$;
begin
  foreach v_signature in array array[
    'public.reserve_tenant_credits(uuid,text,text,bigint,integer)',
    'public.top_up_tenant_credits(uuid,integer,bigint)',
    'public.settle_tenant_credits(uuid,jsonb)'] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    v_definition:=replace(v_definition,v_claim,'app.usage_subject(app.current_tenant_id(),' || v_claim || ')');
    v_definition:=replace(v_definition,E'begin\n',E'begin\n  perform pg_advisory_xact_lock(hashtextextended(''tenant-usage:'' || app.current_tenant_id(),0));\n');
    if v_signature not like '%settle_tenant_credits%' then
      v_definition:=replace(v_definition,E'begin\n',E'begin\n  if exists(select 1 from public.account_erasure_requests where tenant_id=app.current_tenant_id() and user_id=nullif(nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'',''''))\n    or not exists(select 1 from public.tenants where tenant_id=app.current_tenant_id() and status=''active'') then\n    return jsonb_build_object(''allowed'',false,''reason'',''unconfigured'');\n  end if;\n');
    end if;
    if v_signature like '%reserve_tenant_credits%' then
      v_definition:=replace(v_definition,'select * into v_existing','v_user := app.usage_subject(v_tenant,v_user);' || E'\n  select * into v_existing');
    end if;
    execute v_definition;
  end loop;
  select pg_get_functiondef('public.request_account_erasure(text,text,text)'::regprocedure) into v_definition;
  v_definition:=replace(v_definition,'on conflict (user_id)','on conflict (tenant_id,user_id)');
  v_definition:=replace(v_definition,E'begin\n',E'begin\n  perform pg_advisory_xact_lock(hashtextextended(''tenant-usage:'' || app.current_tenant_id(),0));\n  if p_user_id is distinct from nullif(nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'','''') then\n    raise exception using errcode=''42501'', message=''Erasure identity does not match caller'';\n  end if;\n');
  execute v_definition;
end $$;
alter function public.request_account_erasure(text,text,text) security definer;
alter function public.request_account_erasure(text,text,text) set search_path=pg_catalog,pg_temp;
alter function public.complete_account_erasure(text) security definer;
alter function public.complete_account_erasure(text) set search_path=pg_catalog,pg_temp;
do $$ declare v_had boolean:=has_schema_privilege('tenant_definer','public','CREATE'); begin
  grant create on schema public to tenant_definer;
  alter function public.request_account_erasure(text,text,text) owner to tenant_definer;
  alter function public.complete_account_erasure(text) owner to tenant_definer;
  if not v_had then revoke create on schema public from tenant_definer; end if;
end $$;
revoke all on function public.request_account_erasure(text,text,text),public.complete_account_erasure(text)
  from public,web_anon,authenticated;
grant execute on function public.request_account_erasure(text,text,text),public.complete_account_erasure(text)
  to tenant_app,service_role;

-- Scrub records for erasures requested before this migration. Claims must be
-- set per row because the privacy trigger deliberately has no RLS bypass.
set role service_role;
do $$ declare r record; v_claims text:=current_setting('request.jwt.claims',true); begin
  for r in select distinct tenant_id from public.account_erasure_requests loop
    perform set_config('request.jwt.claims',jsonb_build_object('tenant_id',r.tenant_id)::text,true);
    update public.account_erasure_requests set usage_subject=usage_subject where tenant_id=r.tenant_id;
  end loop;
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
end $$;
reset role;

create function public.cp_upsert_tenant(p_tenant_id text,p_display_name text,p_region text,p_stamp text)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_tenant_id is null or p_tenant_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'
    or nullif(btrim(p_display_name),'') is null or length(p_display_name)>200
    or (p_stamp is not null and p_stamp !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$') then
    raise exception using errcode='22023',message='Invalid tenant metadata';
  end if;
  insert into public.tenants(tenant_id,display_name,region,stamp) values(p_tenant_id,btrim(p_display_name),p_region,p_stamp)
    on conflict (tenant_id) do update set display_name=excluded.display_name,region=excluded.region,stamp=excluded.stamp,updated_at=now();
end $$;
create function public.cp_set_storage_location(p_tenant_id text,p_account text,p_container text)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if (p_account is null) <> (p_container is null) then
    raise exception using errcode='22023',message='Supply both storage account and container';
  end if;
  update public.tenants set storage_account=p_account,storage_container=p_container,updated_at=now()
    where tenant_id=p_tenant_id and status<>'offboarding';
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
end $$;
create function public.cp_set_entitlements(p_tenant_id text,p_entitlements jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_key text; v_value jsonb; v_budget jsonb; v_month numeric; v_user numeric; v_soft numeric; v_version text;
begin
  if p_entitlements is null or jsonb_typeof(p_entitlements)<>'object'
    or exists(select 1 from jsonb_object_keys(p_entitlements) k where k<>all(array['keyMode','tier','modelAllowlist','enabledConnectors','featureFlags','config','budget'])) then
    raise exception using errcode='22023',message='Unsupported entitlement fields';
  end if;
  perform 1 from public.tenants where tenant_id=p_tenant_id and status<>'offboarding' for update;
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  for v_key,v_value in select key,value from jsonb_each(p_entitlements) loop
    if (v_key='keyMode' and (jsonb_typeof(v_value)<>'string' or v_value#>>'{}' not in ('platform','byo')))
      or (v_key='tier' and jsonb_typeof(v_value) not in ('string','null'))
      or (v_key in ('featureFlags','config') and jsonb_typeof(v_value)<>'object')
      or (v_key in ('modelAllowlist','enabledConnectors') and jsonb_typeof(v_value) not in ('array','null')) then
      raise exception using errcode='22023',message='Invalid entitlement value';
    end if;
    if v_key in ('modelAllowlist','enabledConnectors') and jsonb_typeof(v_value)='array' then
      if exists(select 1 from jsonb_array_elements(v_value) x where jsonb_typeof(x)<>'string' or nullif(btrim(x#>>'{}'),'') is null) then
        raise exception using errcode='22023',message='Entitlement lists must contain nonempty strings';
      end if;
    end if;
  end loop;
  insert into public.tenant_settings(tenant_id) values(p_tenant_id) on conflict do nothing;
  update public.tenant_settings set
    key_mode=case when p_entitlements?'keyMode' then p_entitlements->>'keyMode' else key_mode end,
    tier=case when p_entitlements?'tier' then p_entitlements->>'tier' else tier end,
    model_allowlist=case when p_entitlements?'modelAllowlist' then
      case when p_entitlements->'modelAllowlist'='null'::jsonb then null else array(select jsonb_array_elements_text(p_entitlements->'modelAllowlist')) end else model_allowlist end,
    enabled_connectors=case when p_entitlements?'enabledConnectors' then
      case when p_entitlements->'enabledConnectors'='null'::jsonb then null else array(select jsonb_array_elements_text(p_entitlements->'enabledConnectors')) end else enabled_connectors end,
    feature_flags=case when p_entitlements?'featureFlags' then p_entitlements->'featureFlags' else feature_flags end,
    config=case when p_entitlements?'config' then p_entitlements->'config' else config end,updated_at=now()
    where tenant_id=p_tenant_id;
  v_budget:=p_entitlements->'budget';
  if v_budget is null or v_budget='null'::jsonb then
    delete from public.tenant_budgets where tenant_id=p_tenant_id;
  else
    if jsonb_typeof(v_budget)<>'object' or exists(select 1 from jsonb_object_keys(v_budget) k
      where k<>all(array['monthlyCredits','perUserCredits','softThreshold','priceVersion'])) then
      raise exception using errcode='22023',message='Invalid credit budget';
    end if;
    foreach v_key in array array['monthlyCredits','perUserCredits','softThreshold'] loop
      v_value:=v_budget->v_key;
      if v_value is null or v_value='null'::jsonb then
        if v_key='monthlyCredits' then raise exception using errcode='22023',message='monthlyCredits is required'; end if;
      elsif jsonb_typeof(v_value)<>'string' or (v_value#>>'{}') !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception using errcode='22023',message='Credits must be nonnegative finite decimal strings';
      end if;
    end loop;
    v_month:=(v_budget->>'monthlyCredits')::numeric;
    v_user:=(v_budget->>'perUserCredits')::numeric;
    v_soft:=(v_budget->>'softThreshold')::numeric;
    v_version:=v_budget->>'priceVersion';
    if jsonb_typeof(v_budget->'priceVersion') is distinct from 'string' or v_version is null
      or not exists(select 1 from app.credit_prices where version=v_version) then
      raise exception using errcode='23503',message='Published credit price version not found';
    end if;
    insert into public.tenant_budgets(tenant_id,monthly_credits,per_user_credits,soft_threshold,price_version)
      values(p_tenant_id,v_month,v_user,v_soft,v_version) on conflict (tenant_id) do update set
      monthly_credits=excluded.monthly_credits,per_user_credits=excluded.per_user_credits,
      soft_threshold=excluded.soft_threshold,price_version=excluded.price_version,updated_at=now();
  end if;
end $$;
create function public.cp_set_secret_refs(p_tenant_id text,p_refs jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_refs is null or jsonb_typeof(p_refs)<>'object' then
    raise exception using errcode='22023',message='Secret references must be an object';
  end if;
  perform 1 from public.tenants where tenant_id=p_tenant_id and status<>'offboarding' for update;
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  insert into public.tenant_settings(tenant_id,secret_refs) values(p_tenant_id,p_refs)
    on conflict (tenant_id) do update set secret_refs=excluded.secret_refs,updated_at=now();
end $$;
create function public.cp_set_group_policies(p_tenant_id text,p_policies jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_policies is null or jsonb_typeof(p_policies)<>'array' then
    raise exception using errcode='22023',message='Group policies must be an array';
  end if;
  if exists(select 1 from jsonb_array_elements(p_policies) x where jsonb_typeof(x)<>'object'
    or jsonb_typeof(x->'groupObjectId') is distinct from 'string'
    or (x->>'groupObjectId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or x->>'role' is null or x->>'role' not in ('TenantAdmin','Member')
    or exists(select 1 from jsonb_object_keys(x) k where k<>all(array['groupObjectId','role']))) then
    raise exception using errcode='22023',message='Invalid group policy';
  end if;
  perform 1 from public.tenants where tenant_id=p_tenant_id and status<>'offboarding' for update;
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  delete from public.tenant_group_policies where tenant_id=p_tenant_id;
  insert into public.tenant_group_policies(tenant_id,group_object_id,role)
    select p_tenant_id,lower(x->>'groupObjectId'),x->>'role' from jsonb_array_elements(p_policies) x;
  perform app.revoke_member_sessions(user_id) from public.tenant_memberships where tenant_id=p_tenant_id;
end $$;
create function public.cp_set_enterprise_role_source(p_tenant_id text,p_source text)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_source is null or p_source not in ('app_roles','groups') then
    raise exception using errcode='22023',message='Invalid enterprise role source';
  end if;
  update public.tenants set enterprise_role_source=p_source,updated_at=now()
    where tenant_id=p_tenant_id and status<>'offboarding';
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  perform app.revoke_member_sessions(user_id) from public.tenant_memberships where tenant_id=p_tenant_id;
end $$;

create function public.cp_set_tenant_status(p_tenant_id text,p_status text)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_status text;
begin
  if p_status is null or p_status not in ('active','suspended','offboarding') then
    raise exception using errcode='22023',message='Invalid tenant status';
  end if;
  select status into v_status from public.tenants where tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='23503',message='Tenant not found'; end if;
  if v_status='offboarding' and p_status<>'offboarding' then
    raise exception using errcode='23514',message='Offboarding cannot be reversed';
  end if;
  update public.tenants set status=p_status,updated_at=now() where tenant_id=p_tenant_id;
  if p_status<>'active' then
    update public.auth_sessions set revoked_at=coalesce(revoked_at,now()),version=version+1,
      refresh_owner=null,refresh_lease_until=null where tenant_id=p_tenant_id and revoked_at is null;
    update public.auth_handoff_tickets set consumed_at=coalesce(consumed_at,now())
      where tenant_id=p_tenant_id and consumed_at is null;
  end if;
  if p_status='offboarding' and not exists(select 1 from public.tenants where tenant_id=p_tenant_id and purged_at is not null) then
    insert into public.db_jobs(tenant_id,kind,payload,dedupe_key,max_attempts)
      values(p_tenant_id,'tenant.purge','{}'::jsonb,'tenant.purge',20)
      on conflict (tenant_id,dedupe_key) where dedupe_key is not null and status in ('pending','running')
      do nothing;
  end if;
end $$;

-- INSERT/UPDATE fencing closes the gap between session revocation and a
-- request or job already in flight. The purge's service-role transaction may
-- still run cascades and lifecycle triggers. Billing settlement stays live.
create function app.reject_offboarded_write() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if current_setting('role',true)='service_role'
    and current_setting('app.purging_tenant',true)=new.tenant_id then return new; end if;
  if tg_table_name='db_jobs' then
    if current_user='service_role' and (tg_op='UPDATE' or new.kind='tenant.purge') then return new; end if;
  end if;
  perform 1 from public.tenants where tenant_id=new.tenant_id and status='offboarding';
  if found then raise exception using errcode='42501',message='Tenant is offboarding'; end if;
  return new;
end $$;
revoke all on function app.reject_offboarded_write() from public,web_anon,authenticated,tenant_app;
do $$ declare r record; begin
  for r in select c.oid::regclass as tbl from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and not c.relispartition
      and c.relname<>all(array['tenants','llm_usage_events','tenant_budgets','tenant_credit_periods','tenant_credit_reservations','account_erasure_requests'])
  loop
    execute format('create trigger tenant_offboarding_fence before insert or update on %s for each row execute function app.reject_offboarded_write()',r.tbl);
  end loop;
end $$;

-- The platform purge owns bucket removal; ordinary rate-limit callers keep
-- their existing grants and the ledger keeps its DELETE refusal.
grant delete on public.tenant_rate_buckets to service_role;

create function public.purge_offboarded_tenant(p_tenant_id text,p_job_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_tables text[]; v_next text[]; v_table text; v_user text; v_claims text:=current_setting('request.jwt.claims',true);
  v_deleted bigint; v_count bigint;
begin
  perform 1 from public.tenants where tenant_id=p_tenant_id and status='offboarding' for update;
  if not found then raise exception using errcode='23514',message='Tenant is not offboarding'; end if;
  perform 1 from public.db_jobs where id=p_job_id and tenant_id=p_tenant_id and kind='tenant.purge'
    and status='running' and claim_token=p_claim_token and lease_expires_at>now() for update;
  if not found then raise exception using errcode='42501',message='Tenant purge claim lost'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('tenant_id',p_tenant_id)::text,true);
  perform set_config('app.purging_tenant',p_tenant_id,true);
  perform pg_advisory_xact_lock(hashtextextended('tenant-usage:' || p_tenant_id,0));
  for v_user in select user_id from public.llm_usage_events where tenant_id=p_tenant_id and user_id is not null and user_id not like 'erased:%'
    union select user_id from public.tenant_credit_reservations where tenant_id=p_tenant_id and user_id is not null and user_id not like 'erased:%'
    union select subject from public.tenant_credit_periods where tenant_id=p_tenant_id and subject<>'' and subject not like 'erased:%'
  loop
    insert into public.account_erasure_requests(tenant_id,user_id,status,completed_at) values(p_tenant_id,v_user,'complete',now())
      on conflict (tenant_id,user_id) do nothing;
  end loop;
  -- FK and ownership guards retry after their parent/child dependencies. Successful
  -- empty tables count as progress; an unresolvable cycle fails atomically.
  -- Lifecycle triggers (main's org departure audit, 0126/0131) may write rows
  -- into an already-purged table while later tables are deleted, so whole
  -- passes repeat until one deletes nothing.
  loop
    v_deleted:=0;
    select array_agg(c.relname order by c.relname) into v_tables
      from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
      where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and not c.relispartition
        and c.relname<>all(array['tenants','llm_usage_events','tenant_budgets','tenant_credit_periods','tenant_credit_reservations','account_erasure_requests','db_jobs']);
    while coalesce(cardinality(v_tables),0)>0 loop
      v_next:='{}'::text[];
      foreach v_table in array v_tables loop
        begin
          execute format('delete from public.%I where tenant_id=$1',v_table) using p_tenant_id;
          get diagnostics v_count = row_count;
          v_deleted:=v_deleted+v_count;
        exception when foreign_key_violation or check_violation then
          v_next:=array_append(v_next,v_table);
        end;
      end loop;
      if cardinality(v_next)=cardinality(v_tables) then
        raise exception 'Tenant purge has unresolved dependencies: %',array_to_string(v_next,', ');
      end if;
      v_tables:=v_next;
    end loop;
    exit when v_deleted=0;
  end loop;
  -- The control plane deletes the tenant's storage account after purged_at.
  -- Keep this claimed job so the normal claim-token completion still works.
  delete from public.db_jobs where tenant_id=p_tenant_id and id<>p_job_id;
  update public.tenants set purged_at=coalesce(purged_at,now()),updated_at=now() where tenant_id=p_tenant_id;
  perform set_config('app.purging_tenant','',true);
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
  return true;
end $$;

-- Cross-tenant views have the platform owner's rights and intentionally
-- expose only these columns: no actors, email, titles, prompts or payloads.
create view public.cp_daily_usage with (security_barrier=true) as
  select tenant_id,(created_at at time zone 'UTC')::date as usage_date,feature,provider,model,key_mode,
    count(*) as calls,sum(input_tokens) as input_tokens,sum(output_tokens) as output_tokens,
    sum(cache_read_tokens) as cache_read_tokens,sum(cache_write_tokens) as cache_write_tokens,
    credit_period,sum(credits) as credits from public.llm_usage_events
    group by tenant_id,(created_at at time zone 'UTC')::date,feature,provider,model,key_mode,credit_period;
create view public.cp_audit_events with (security_barrier=true) as
  select id,tenant_id,created_at,action,status,surface from public.audit_events;
create view public.cp_storage_locations with (security_barrier=true) as
  select tenant_id,display_name,status,region,stamp,storage_account,storage_container,purged_at from public.tenants;
create view public.cp_user_counts with (security_barrier=true) as
  select t.tenant_id,count(m.user_id) as users,count(m.user_id) filter(where m.role='TenantAdmin') as admins
  from public.tenants t left join public.tenant_memberships m on m.tenant_id=t.tenant_id group by t.tenant_id;

do $$ declare v_had boolean:=has_schema_privilege('service_role','public','CREATE'); v_signature text; begin
  grant create on schema public to service_role;
  foreach v_signature in array array['cp_upsert_tenant(text,text,text,text)','cp_set_tenant_status(text,text)',
    'cp_set_storage_location(text,text,text)','cp_set_entitlements(text,jsonb)','cp_set_group_policies(text,jsonb)',
    'cp_set_secret_refs(text,jsonb)','cp_set_enterprise_role_source(text,text)','purge_offboarded_tenant(text,uuid,uuid)'] loop
    execute format('alter function public.%s owner to service_role',v_signature);
    execute format('revoke all on function public.%s from public,web_anon,authenticated,tenant_app,control_plane',v_signature);
    execute format('grant execute on function public.%s to service_role',v_signature);
  end loop;
  alter view public.cp_daily_usage owner to service_role;
  alter view public.cp_audit_events owner to service_role;
  alter view public.cp_storage_locations owner to service_role;
  alter view public.cp_user_counts owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;

-- PUBLIC privileges cannot be denied to just one role. Replace inherited
-- PUBLIC rights with equivalent explicit rights for the existing role tier.
-- No existing application role loses access; control_plane gains none.
do $$ declare r record; v_role text; v_priv text; begin
  for r in select p.oid,p.oid::regprocedure as fn from pg_proc p
    where p.pronamespace in ('public'::regnamespace,'app'::regnamespace) and p.prokind='f'
      and exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and not exists(select 1 from pg_depend d join pg_extension e on e.oid=d.refobjid
        where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e' and e.extname in ('pgcrypto','pg_trgm')) loop
    foreach v_role in array array['web_anon','authenticated','tenant_app','tenant_definer','service_role'] loop
      if has_function_privilege(v_role,r.oid,'EXECUTE') then execute format('grant execute on function %s to %I',r.fn,v_role); end if;
    end loop;
    execute format('revoke execute on function %s from public',r.fn);
  end loop;
  for r in select c.oid,c.oid::regclass as tbl,c.relkind from pg_class c
    where c.relnamespace in ('public'::regnamespace,'app'::regnamespace) and c.relkind in ('r','p','v','m','S') loop
    if r.relkind='S' then
      foreach v_priv in array array['SELECT','UPDATE','USAGE'] loop
        foreach v_role in array array['web_anon','authenticated','tenant_app','tenant_definer','service_role'] loop
          if has_sequence_privilege(v_role,r.oid,v_priv) then execute format('grant %s on sequence %s to %I',v_priv,r.tbl,v_role); end if;
        end loop;
      end loop;
      execute format('revoke all on sequence %s from public,control_plane',r.tbl);
    else
      foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if exists(select 1 from aclexplode(coalesce((select relacl from pg_class where oid=r.oid),acldefault('r',(select relowner from pg_class where oid=r.oid)))) a where a.grantee=0 and a.privilege_type=v_priv) then
          foreach v_role in array array['web_anon','authenticated','tenant_app','tenant_definer','service_role'] loop
            if has_table_privilege(v_role,r.oid,v_priv) then execute format('grant %s on table %s to %I',v_priv,r.tbl,v_role); end if;
          end loop;
        end if;
      end loop;
      execute format('revoke all on table %s from public,control_plane',r.tbl);
    end if;
  end loop;
end $$;
alter default privileges revoke execute on functions from public;
grant execute on function public.cp_upsert_tenant(text,text,text,text),public.cp_set_tenant_status(text,text),
  public.cp_set_storage_location(text,text,text),public.cp_set_entitlements(text,jsonb),public.cp_set_group_policies(text,jsonb),
  public.cp_set_secret_refs(text,jsonb),public.cp_set_enterprise_role_source(text,text),public.cp_add_member(text,text,text),
  public.cp_remove_member(text),public.cp_move_member(text,text),public.cp_set_member_role(text,text),
  public.cp_link_identity_source(text,text),public.cp_unlink_identity_source(text) to control_plane;
revoke all on public.cp_daily_usage,public.cp_audit_events,public.cp_storage_locations,public.cp_user_counts
  from public,web_anon,authenticated,tenant_app,tenant_definer;
grant select on public.cp_daily_usage,public.cp_audit_events,public.cp_storage_locations,public.cp_user_counts to control_plane;

-- Preserve 0119/0124's gate and explicitly extend both platform allowlists.
do $$ declare v_definition text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition,'''cp_add_member'',',
    '''cp_upsert_tenant'', ''cp_set_tenant_status'', ''cp_set_storage_location'', ''cp_set_entitlements'', ''cp_set_group_policies'', ''cp_set_secret_refs'', ''cp_set_enterprise_role_source'', ''purge_offboarded_tenant'', ''cp_add_member'',');
end $$;
create function app.control_plane_gaps() returns table(object text,problem text)
language sql stable set search_path=pg_catalog,pg_temp as $$
  select r.rolname::text,'control_plane has unsafe role attributes' from pg_roles r where r.rolname='control_plane'
    and (not r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication)
  union all select 'control_plane','control_plane has role membership' from pg_auth_members where member='control_plane'::regrole
  union all select p.oid::regprocedure::text,'control_plane may execute an unsupported function' from pg_proc p
    where p.pronamespace in ('public'::regnamespace,'app'::regnamespace)
      and has_function_privilege('control_plane',p.oid,'EXECUTE')
      -- Trusted extension utility functions retain their bootstrap owner's
      -- PUBLIC rights, like pg_catalog builtins. They are not definer entrypoints.
      and not (not p.prosecdef and exists(select 1 from pg_depend d join pg_extension e on e.oid=d.refobjid
        where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e' and e.extname in ('pgcrypto','pg_trgm')))
      and p.oid<>all(array[
        'public.cp_upsert_tenant(text,text,text,text)'::regprocedure,'public.cp_set_tenant_status(text,text)'::regprocedure,
        'public.cp_set_storage_location(text,text,text)'::regprocedure,'public.cp_set_entitlements(text,jsonb)'::regprocedure,
        'public.cp_set_group_policies(text,jsonb)'::regprocedure,'public.cp_set_secret_refs(text,jsonb)'::regprocedure,
        'public.cp_set_enterprise_role_source(text,text)'::regprocedure,'public.cp_add_member(text,text,text)'::regprocedure,
        'public.cp_remove_member(text)'::regprocedure,'public.cp_move_member(text,text)'::regprocedure,
        'public.cp_set_member_role(text,text)'::regprocedure,'public.cp_link_identity_source(text,text)'::regprocedure,
        'public.cp_unlink_identity_source(text)'::regprocedure]::oid[])
  union all select c.oid::regclass::text,'control_plane has unsupported table privileges' from pg_class c
    where c.relnamespace in ('public'::regnamespace,'app'::regnamespace) and c.relkind in ('r','p','v','m')
      and (has_table_privilege('control_plane',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or (has_any_column_privilege('control_plane',c.oid,'SELECT') and c.oid<>all(array[
          'public.cp_daily_usage'::regclass,'public.cp_audit_events'::regclass,'public.cp_storage_locations'::regclass,'public.cp_user_counts'::regclass]::oid[])))
$$;
revoke all on function app.control_plane_gaps() from public,web_anon,authenticated,tenant_app,control_plane;
grant execute on function app.control_plane_gaps() to service_role;
do $$ declare v_definition text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition,'order by 1','union all select * from app.control_plane_gaps() order by 1');
end $$;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem,'; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'multi-tenant 018: %',v_gaps; end if;
end $$;
notify pgrst,'reload schema';
