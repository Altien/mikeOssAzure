-- Migration date: 2026-08-26

-- Model preferences are optional. A null title model means "derive the
-- cheapest model from the chat provider"; a null tabular model means the user
-- has not chosen a default for new reviews.
alter table public.user_profiles
  alter column tabular_model drop default,
  alter column tabular_model drop not null,
  add column if not exists last_used_chat_model text;

-- Each conversation remembers the model that most recently handled it. The
-- user-profile value is a cross-surface fallback, not an account default.
alter table public.chats
  add column if not exists model text;

alter table public.word_chats
  add column if not exists model text;

-- Tabular reviews pin their own model so a long-running review never changes
-- behavior because the owner's account-level default changed later.
alter table public.tabular_reviews
  add column if not exists model text;

-- Preserve the effective choice for existing reviews where the owner already
-- has a saved tabular preference. New reviews must provide a model through the
-- API; rows that cannot be backfilled remain explicitly unconfigured.
update public.tabular_reviews as review
set model = profile.tabular_model
from public.user_profiles as profile
where review.user_id = profile.user_id
  and review.model is null
  and nullif(btrim(profile.tabular_model), '') is not null;

-- PostgreSQL cannot change a table-returning function's result shape with
-- CREATE OR REPLACE, so recreate the overview RPC with the chat model added.
drop function if exists public.get_chats_overview(text, integer, integer);

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       p.id is not null
       and p.user_id::text = p_user_id
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;
