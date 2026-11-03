-- 016: operator-owned price versions and tenant-scoped, atomic credit holds.
-- Prices are deliberately empty: the operator publishes its own credit policy.
create table app.credit_prices (
  version text not null check (version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  provider text not null check (btrim(provider) <> ''),
  model text not null check (btrim(model) <> ''),
  input_per_million numeric not null check (input_per_million >= 0 and input_per_million < 'Infinity'::numeric),
  output_per_million numeric not null check (output_per_million >= 0 and output_per_million < 'Infinity'::numeric),
  cache_read_per_million numeric not null check (cache_read_per_million >= 0 and cache_read_per_million < 'Infinity'::numeric),
  cache_write_per_million numeric not null check (cache_write_per_million >= 0 and cache_write_per_million < 'Infinity'::numeric),
  max_output_tokens integer not null check (max_output_tokens > 0),
  published_at timestamptz not null default now(),
  primary key (version, provider, model)
);
revoke all on app.credit_prices from public, web_anon, authenticated, tenant_app, service_role;
grant select on app.credit_prices to service_role;
grant select, insert on app.credit_prices to tenant_definer;
create function app.immutable_credit_prices() returns trigger language plpgsql as $$
begin raise exception using errcode = '23514', message = 'Publish a new credit price version'; end $$;
revoke all on function app.immutable_credit_prices() from public, web_anon, authenticated;
create trigger immutable_credit_prices before update or delete on app.credit_prices
  for each row execute function app.immutable_credit_prices();

create table public.tenant_budgets (
  tenant_id text primary key default app.tenant_id_default() references public.tenants(tenant_id),
  monthly_credits numeric not null check (monthly_credits >= 0 and monthly_credits < 'Infinity'::numeric),
  per_user_credits numeric check (per_user_credits >= 0 and per_user_credits < 'Infinity'::numeric),
  soft_threshold numeric check (soft_threshold between 0 and 1),
  price_version text not null,
  updated_at timestamptz not null default now()
);
-- subject='' is the tenant aggregate; other subjects are immutable user IDs.
create table public.tenant_credit_periods (
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  period_start date not null check (extract(day from period_start) = 1),
  subject text not null default '',
  used_credits numeric not null default 0 check (used_credits >= 0 and used_credits < 'Infinity'::numeric),
  reserved_credits numeric not null default 0 check (reserved_credits >= 0 and reserved_credits < 'Infinity'::numeric),
  primary key (tenant_id, period_start, subject)
);
create table public.tenant_credit_reservations (
  id uuid primary key,
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  user_id text,
  period_start date not null,
  price_version text not null,
  provider text not null,
  model text not null,
  max_output_tokens integer not null,
  initial_bound numeric not null check (initial_bound >= 0 and initial_bound < 'Infinity'::numeric),
  reserved_credits numeric not null check (reserved_credits >= 0 and reserved_credits < 'Infinity'::numeric),
  next_step integer not null default 0,
  settled_credits numeric check (settled_credits >= 0 and settled_credits < 'Infinity'::numeric),
  ledger_id bigint,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  foreign key (price_version, provider, model) references app.credit_prices(version, provider, model)
);
create index tenant_credit_reservations_pending on public.tenant_credit_reservations(tenant_id, created_at) where settled_at is null;
select app.enable_tenant_rls('public.tenant_budgets');
select app.enable_tenant_rls('public.tenant_credit_periods');
select app.enable_tenant_rls('public.tenant_credit_reservations');
revoke all on public.tenant_budgets, public.tenant_credit_periods, public.tenant_credit_reservations
  from public, web_anon, authenticated, tenant_app;
grant select on public.tenant_budgets, public.tenant_credit_periods, public.tenant_credit_reservations to tenant_app;
grant select, insert, update, delete on public.tenant_budgets to service_role;
grant select on public.tenant_credit_periods, public.tenant_credit_reservations to service_role;
revoke insert, update, delete on public.tenant_budgets from tenant_definer;
-- PostgreSQL row-lock clauses require UPDATE on at least one column.
grant update(updated_at) on public.tenant_budgets to tenant_definer;

alter table public.llm_usage_events add column credit_reservation_id uuid,
  add column credit_period date, add column credits numeric,
  add column completed_at timestamptz;
comment on column public.llm_usage_events.created_at is 'Budgeted calls use admission time (original credit month); other calls use recording time. completed_at records settlement time.';

-- SDK input_tokens includes the cache classes. Charge uncached input once.
create function app.credit_cost(p_price app.credit_prices, p_input bigint, p_output bigint, p_read bigint, p_write bigint)
returns numeric language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (greatest(0, p_input - p_read - p_write) * p_price.input_per_million
    + p_output * p_price.output_per_million + p_read * p_price.cache_read_per_million
    + p_write * p_price.cache_write_per_million) / 1000000::numeric
$$;
revoke all on function app.credit_cost(app.credit_prices,bigint,bigint,bigint,bigint) from public, web_anon, authenticated, tenant_app;
grant execute on function app.credit_cost(app.credit_prices,bigint,bigint,bigint,bigint) to tenant_definer, service_role;

-- The aggregate row is locked before the user row, serialising every writer
-- for this tenant/month. A denial changes no counter, including user-cap denials.
create function app.try_reserve_credits(p_tenant text, p_period date, p_user text, p_amount numeric, p_limit numeric, p_user_limit numeric)
returns boolean language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_total public.tenant_credit_periods; v_user public.tenant_credit_periods;
begin
  insert into public.tenant_credit_periods(tenant_id,period_start,subject) values(p_tenant,p_period,'') on conflict do nothing;
  select * into v_total from public.tenant_credit_periods where tenant_id=p_tenant and period_start=p_period and subject='' for update;
  if v_total.used_credits + v_total.reserved_credits + p_amount > p_limit then return false; end if;
  if p_user is not null then
    insert into public.tenant_credit_periods(tenant_id,period_start,subject) values(p_tenant,p_period,p_user) on conflict do nothing;
    select * into v_user from public.tenant_credit_periods where tenant_id=p_tenant and period_start=p_period and subject=p_user for update;
    if p_user_limit is not null and v_user.used_credits + v_user.reserved_credits + p_amount > p_user_limit then return false; end if;
  end if;
  update public.tenant_credit_periods set reserved_credits=reserved_credits+p_amount
    where tenant_id=p_tenant and period_start=p_period and (subject='' or subject=p_user);
  return true;
end $$;
revoke all on function app.try_reserve_credits(text,date,text,numeric,numeric,numeric) from public, web_anon, authenticated, tenant_app;
grant execute on function app.try_reserve_credits(text,date,text,numeric,numeric,numeric) to tenant_definer;

create function public.publish_credit_prices(p_version text, p_prices jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_count integer;
begin
  if p_version is null or p_prices is null or jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices)=0 then
    raise exception using errcode='23514', message='A version and a nonempty model price array are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credit-prices:' || p_version, 0));
  if exists(select 1 from app.credit_prices where version=p_version) then
    raise exception using errcode='23505', message='Credit price version is already published';
  end if;
  insert into app.credit_prices(version,provider,model,input_per_million,output_per_million,cache_read_per_million,cache_write_per_million,max_output_tokens)
    select p_version, provider, model, input_per_million, output_per_million, cache_read_per_million, cache_write_per_million, max_output_tokens
    from jsonb_to_recordset(p_prices) as p(provider text, model text, input_per_million numeric, output_per_million numeric, cache_read_per_million numeric, cache_write_per_million numeric, max_output_tokens integer);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function public.reserve_tenant_credits(p_id uuid, p_provider text, p_model text, p_input_tokens bigint, p_output_tokens integer default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_tenant text := app.current_tenant_id();
  v_user text := nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','');
  v_period date := date_trunc('month', now() at time zone 'UTC')::date;
  v_budget public.tenant_budgets; v_price app.credit_prices; v_amount numeric; v_output integer; v_warning boolean;
  v_existing public.tenant_credit_reservations;
begin
  if v_tenant is null or p_input_tokens < 0 or p_input_tokens is null or p_output_tokens <= 0 then
    raise exception using errcode='23514', message='Invalid credit reservation';
  end if;
  select * into v_existing from public.tenant_credit_reservations where id=p_id;
  if found then
    if v_existing.settled_at is not null then return jsonb_build_object('allowed',false,'reason','settled'); end if;
    if v_existing.user_id is distinct from v_user or v_existing.provider<>p_provider or v_existing.model<>p_model then
      raise exception using errcode='42501', message='Reservation does not match caller';
    end if;
    return jsonb_build_object('allowed',true,'id',p_id,'price_version',v_existing.price_version,'period_start',v_existing.period_start,'max_output_tokens',v_existing.max_output_tokens);
  end if;
  select * into v_budget from public.tenant_budgets where tenant_id=v_tenant for share;
  if not found then return jsonb_build_object('allowed',false,'reason','unconfigured'); end if;
  select * into v_price from app.credit_prices where version=v_budget.price_version and provider=p_provider and model=p_model;
  if not found then return jsonb_build_object('allowed',false,'reason','pricing_unavailable'); end if;
  v_output := least(coalesce(p_output_tokens,v_price.max_output_tokens),v_price.max_output_tokens);
  v_amount := (p_input_tokens * greatest(v_price.input_per_million,v_price.cache_read_per_million,v_price.cache_write_per_million) + v_output*v_price.output_per_million) / 1000000::numeric;
  if not app.try_reserve_credits(v_tenant,v_period,v_user,v_amount,v_budget.monthly_credits,v_budget.per_user_credits) then
    return jsonb_build_object('allowed',false,'reason','exhausted');
  end if;
  insert into public.tenant_credit_reservations(id,tenant_id,user_id,period_start,price_version,provider,model,max_output_tokens,initial_bound,reserved_credits)
    values(p_id,v_tenant,v_user,v_period,v_price.version,p_provider,p_model,v_output,v_amount,v_amount);
  select v_budget.soft_threshold is not null and used_credits+reserved_credits >= v_budget.monthly_credits*v_budget.soft_threshold
    into v_warning from public.tenant_credit_periods where tenant_id=v_tenant and period_start=v_period and subject='';
  return jsonb_build_object('allowed',true,'id',p_id,'price_version',v_price.version,'period_start',v_period,'max_output_tokens',v_output,'warning',v_warning);
end $$;

create function public.top_up_tenant_credits(p_id uuid, p_step integer, p_input_tokens bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_res public.tenant_credit_reservations; v_budget public.tenant_budgets; v_price app.credit_prices; v_amount numeric;
begin
  select * into v_res from public.tenant_credit_reservations where id=p_id for update;
  if not found or v_res.settled_at is not null or p_input_tokens is null or p_input_tokens<0 or p_step is null or p_step<0
    or v_res.user_id is distinct from nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','') then
    raise exception using errcode='23514', message='Invalid credit reservation step';
  end if;
  if p_step < v_res.next_step then return jsonb_build_object('allowed',true); end if;
  if p_step <> v_res.next_step then raise exception using errcode='23514', message='Credit reservation step out of order'; end if;
  select * into v_price from app.credit_prices where version=v_res.price_version and provider=v_res.provider and model=v_res.model;
  v_amount := (p_input_tokens * greatest(v_price.input_per_million,v_price.cache_read_per_million,v_price.cache_write_per_million) + v_res.max_output_tokens*v_price.output_per_million) / 1000000::numeric;
  if p_step=0 then v_amount := greatest(0,v_amount-v_res.initial_bound); end if;
  select * into v_budget from public.tenant_budgets where tenant_id=v_res.tenant_id for share;
  if not found then return jsonb_build_object('allowed',false,'reason','unconfigured'); end if;
  if not app.try_reserve_credits(v_res.tenant_id,v_res.period_start,v_res.user_id,v_amount,v_budget.monthly_credits,v_budget.per_user_credits) then
    return jsonb_build_object('allowed',false,'reason','exhausted');
  end if;
  update public.tenant_credit_reservations set reserved_credits=reserved_credits+v_amount,next_step=next_step+1 where id=p_id;
  return jsonb_build_object('allowed',true);
end $$;

create function public.settle_tenant_credits(p_id uuid, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_res public.tenant_credit_reservations; v_price app.credit_prices; v_amount numeric; v_ledger bigint;
  v_input bigint := (p_event->>'input_tokens')::bigint; v_output bigint := (p_event->>'output_tokens')::bigint;
  v_read bigint := (p_event->>'cache_read_tokens')::bigint; v_write bigint := (p_event->>'cache_write_tokens')::bigint;
begin
  select * into v_res from public.tenant_credit_reservations where id=p_id for update;
  if not found or v_res.user_id is distinct from nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','') then
    raise exception using errcode='42501', message='Credit reservation not found';
  end if;
  if v_res.settled_at is not null then return jsonb_build_object('credits',v_res.settled_credits,'ledger_id',v_res.ledger_id); end if;
  if v_input is null or v_input<0 or v_output is null or v_output<0 or v_read is null or v_read<0 or v_write is null or v_write<0 or v_read+v_write>v_input then
    raise exception using errcode='23514', message='Invalid metered credit usage';
  end if;
  select * into v_price from app.credit_prices where version=v_res.price_version and provider=v_res.provider and model=v_res.model;
  v_amount := app.credit_cost(v_price,v_input,v_output,v_read,v_write);
  -- Lock the aggregate before touching user counters, as reservation does.
  perform 1 from public.tenant_credit_periods where tenant_id=v_res.tenant_id and period_start=v_res.period_start and subject='' for update;
  insert into public.llm_usage_events(tenant_id,created_at,completed_at,user_id,request_id,feature,provider,model,key_mode,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,steps,usage_estimated,outcome,latency_ms,provider_response_id,price_table_version,
    credit_reservation_id,credit_period,credits)
    values(v_res.tenant_id,v_res.created_at,now(),v_res.user_id,p_event->>'request_id',p_event->>'feature',v_res.provider,v_res.model,'platform',
      v_input,v_output,v_read,v_write,(p_event->>'steps')::integer,(p_event->>'usage_estimated')::boolean,p_event->>'outcome',(p_event->>'latency_ms')::integer,p_event->>'provider_response_id',v_res.price_version,
      p_id,v_res.period_start,v_amount) returning id into v_ledger;
  update public.tenant_credit_periods set reserved_credits=reserved_credits-v_res.reserved_credits, used_credits=used_credits+v_amount
    where tenant_id=v_res.tenant_id and period_start=v_res.period_start and (subject='' or subject=v_res.user_id);
  update public.tenant_credit_reservations set settled_credits=v_amount,settled_at=now(),ledger_id=v_ledger where id=p_id;
  return jsonb_build_object('credits',v_amount,'ledger_id',v_ledger,'underestimated',v_amount>v_res.reserved_credits);
end $$;

-- No RLS bypass: each request function is owned by tenant_definer.
do $$ declare v_had boolean := has_schema_privilege('tenant_definer','public','CREATE'); begin
  grant create on schema public to tenant_definer;
  alter function public.publish_credit_prices(text,jsonb) owner to tenant_definer;
  alter function public.reserve_tenant_credits(uuid,text,text,bigint,integer) owner to tenant_definer;
  alter function public.top_up_tenant_credits(uuid,integer,bigint) owner to tenant_definer;
  alter function public.settle_tenant_credits(uuid,jsonb) owner to tenant_definer;
  if not v_had then revoke create on schema public from tenant_definer; end if;
end $$;
revoke all on function public.publish_credit_prices(text,jsonb), public.reserve_tenant_credits(uuid,text,text,bigint,integer),
  public.top_up_tenant_credits(uuid,integer,bigint), public.settle_tenant_credits(uuid,jsonb) from public, web_anon, authenticated, tenant_app;
grant execute on function public.publish_credit_prices(text,jsonb) to service_role;
grant execute on function public.reserve_tenant_credits(uuid,text,text,bigint,integer), public.top_up_tenant_credits(uuid,integer,bigint), public.settle_tenant_credits(uuid,jsonb) to tenant_app, service_role;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem,'; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 016: tenant RLS gaps: %',v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
