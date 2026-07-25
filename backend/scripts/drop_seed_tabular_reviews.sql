-- Remove rows created by seed_tabular_reviews.sql.
--
-- Run in the Supabase SQL editor (or via `psql "$DATABASE_URL" -f
-- backend/scripts/drop_seed_tabular_reviews.sql`). Edit seed_email/seed_prefix
-- below to match what you used to seed, then run.
--
-- Leave seed_email null to target the first user created in this database,
-- matching seed_tabular_reviews.sql's default.

with settings as (
  select
    null::text as seed_email,
    '[SEED]'::text as seed_prefix
),
target_user as (
  select up.user_id
  from public.user_profiles up
  cross join settings s
  where s.seed_email is null or lower(up.email) = lower(s.seed_email)
  order by up.created_at
  limit 1
)
delete from public.tabular_reviews tr
using target_user tu, settings s
where tr.user_id = tu.user_id::text
  and tr.title like s.seed_prefix || '%';

-- If the result says "DELETE 0", either nothing matched seed_prefix or
-- seed_email didn't resolve to a user_profiles row — double-check both above.
