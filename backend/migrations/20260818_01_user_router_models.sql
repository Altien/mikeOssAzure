-- Router-neutral model selections. OpenRouter is the first implementation,
-- but `router` intentionally accepts stable slugs such as `vercel` so adding
-- another gateway does not require another persistence redesign.
create table if not exists public.user_router_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  router text not null
    check (router ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  model_id text not null
    check (
      model_id = btrim(model_id)
      and char_length(model_id) between 1 and 200
      and model_id !~ '\s'
    ),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, router, model_id)
);

create index if not exists idx_user_router_models_user_router_order
  on public.user_router_models (user_id, router, sort_order, created_at);

alter table public.user_router_models enable row level security;
revoke all on public.user_router_models from anon, authenticated;
grant select, insert, update, delete
  on public.user_router_models
  to service_role;

-- Atomically replaces one router's ordered model selection. Keeping this
-- operation in Postgres avoids the lost/partial update possible with a
-- client-side delete followed by multiple inserts.
create or replace function public.replace_user_router_models(
  target_user_id uuid,
  target_router text,
  target_model_ids text[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if target_router !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid router slug';
  end if;

  if coalesce(array_length(target_model_ids, 1), 0) > 50 then
    raise exception 'A router can have at most 50 selected models';
  end if;

  delete from public.user_router_models
  where user_id = target_user_id and router = target_router;

  insert into public.user_router_models (
    user_id,
    router,
    model_id,
    sort_order
  )
  select
    target_user_id,
    target_router,
    model_id,
    ordinality - 1
  from unnest(coalesce(target_model_ids, '{}'::text[]))
    with ordinality as selected(model_id, ordinality);
end;
$$;

revoke all on function public.replace_user_router_models(uuid, text, text[])
  from public, anon, authenticated;
grant execute
  on function public.replace_user_router_models(uuid, text, text[])
  to service_role;

-- Upgrade databases that briefly stored OpenRouter selections as an array on
-- user_profiles. The compatibility column is retained for a rolling deploy;
-- the application treats user_router_models as canonical after this migration.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_profiles'
      and column_name = 'openrouter_models'
  ) then
    execute $migration$
      insert into public.user_router_models (
        user_id,
        router,
        model_id,
        sort_order
      )
      select
        profile.user_id,
        'openrouter',
        selected.model_id,
        selected.ordinality - 1
      from public.user_profiles profile
      cross join lateral unnest(profile.openrouter_models)
        with ordinality as selected(model_id, ordinality)
      where selected.model_id is not null
        and btrim(selected.model_id) <> ''
        and not exists (
          select 1
          from public.user_router_models existing
          where existing.user_id = profile.user_id
            and existing.router = 'openrouter'
        )
      on conflict (user_id, router, model_id) do update
        set sort_order = excluded.sort_order,
            updated_at = now()
    $migration$;
  end if;
end;
$$;
