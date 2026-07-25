-- Seed fake tabular_reviews rows for local pagination smoke testing.
--
-- Run this in the Supabase SQL editor (or via `psql "$DATABASE_URL" -f
-- backend/scripts/seed_tabular_reviews.sql`) against your local/dev database.
--
-- Edit the settings below, then run the whole file. Rows are titled with the
-- prefix so they're easy to spot and to remove later with
-- drop_seed_tabular_reviews.sql.
--
-- Leave seed_email null to seed against the first user created in this
-- database (handy for a fresh local/dev instance) — set it to target a
-- specific login instead.

with settings as (
  select
    null::text as seed_email,               -- your login email, or null for the first user in the db
    60 as seed_count,                        -- how many reviews to create
    '[SEED]'::text as seed_prefix,           -- title prefix, must match the cleanup script
    null::uuid as seed_project_id            -- optional: attach reviews to one project
),
target_user as (
  select up.user_id
  from public.user_profiles up
  cross join settings s
  where s.seed_email is null or lower(up.email) = lower(s.seed_email)
  order by up.created_at
  limit 1
),
seed_rows as (
  select generate_series(1, (select seed_count from settings)) as n
),
sample_columns as (
  select jsonb_build_array(
    jsonb_build_object('index', 0, 'name', 'Governing Law', 'prompt', 'What governing law clause applies?'),
    jsonb_build_object('index', 1, 'name', 'Termination', 'prompt', 'Summarize the termination provisions.'),
    jsonb_build_object('index', 2, 'name', 'Liability Cap', 'prompt', 'What is the liability cap, if any?')
  ) as all_columns
)
insert into public.tabular_reviews (
  user_id, project_id, title, columns_config, document_ids, shared_with, created_at
)
select
  tu.user_id,
  s.seed_project_id,
  s.seed_prefix || ' Review ' || sr.n,
  -- vary the column count per row so the "Columns" column isn't identical everywhere
  (select jsonb_agg(col) from jsonb_array_elements(sc.all_columns) with ordinality as t(col, ord)
    where ord <= 1 + (sr.n % 3)),
  '[]'::jsonb,
  '[]'::jsonb,
  -- stagger created_at so `order by created_at desc` gives a stable, distinct
  -- page order instead of ties from a single insert batch
  now() - (sr.n || ' minutes')::interval
from seed_rows sr
cross join target_user tu
cross join settings s
cross join sample_columns sc;

-- If the result says "INSERT 0 0" instead of "INSERT 0 <seed_count>", either
-- the seed_email in settings didn't match any row in user_profiles, or the
-- table has no users at all yet — fix the email (or create a user) and
-- re-run.
