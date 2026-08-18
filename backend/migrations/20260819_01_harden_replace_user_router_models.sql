-- Serialize concurrent replacements of one user's router selection.
--
-- WHY THIS IS A SEPARATE MIGRATION RATHER THAN AN EDIT TO 20260818_01:
-- 20260818_01_user_router_models.sql is already merged, so a deployment may
-- have run it. A migration that has run is history: editing it in place
-- changes nothing on the databases that already applied it, while quietly
-- disagreeing with what they actually contain. The correction therefore
-- ships forward, as its own dated step, exactly like any other schema
-- change. 20260818_01 keeps the body it shipped with; this file replaces
-- the function so that upgraded deployments end up where a fresh install
-- from schema.sql already is.
--
-- WHAT AN ADVISORY TRANSACTION LOCK IS: Postgres lets an application take a
-- lock on an arbitrary number it chooses (pg_advisory_xact_lock) rather than
-- on a table or row. Sessions that pick the same number queue behind each
-- other; everyone else is untouched; the lock releases itself at
-- commit/rollback, so it cannot leak.
--
-- WHY IT'S NEEDED: the function replaces a selection by delete+insert. Two
-- overlapping PATCHes for the same user+router could interleave — both
-- delete, both insert — and the second insert dies on the
-- (user_id, router, model_id) unique constraint as a 500. Locking on a hash
-- of user_id:router serializes exactly those two requests (last writer
-- wins) with zero effect on other users or routers.
--
-- Nothing else about the function changes, and the table itself is
-- untouched. `create or replace function` preserves the existing privileges,
-- but the revoke/grant pair is restated below so this file is self-contained
-- and re-runnable.
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

  -- Serialize concurrent replacements of the SAME user+router selection.
  -- Two overlapping PATCHes would otherwise interleave delete+insert and one
  -- of them would die on the (user_id, router, model_id) unique constraint.
  -- An advisory xact lock is keyed by an application-chosen value (here a
  -- hash of user+router), blocks only the matching key, and releases itself
  -- at commit/rollback — no table-wide locking, nothing left behind.
  perform pg_advisory_xact_lock(
    hashtext(target_user_id::text || ':' || target_router)
  );

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
