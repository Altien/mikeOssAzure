-- Remove rows created by seed_tabular_reviews.sql.
--
-- Run in the Supabase SQL editor (or via `psql "$DATABASE_URL" -f
-- backend/scripts/drop_seed_tabular_reviews.sql`). Edit seed_email/seed_prefix
-- below to match what you used to seed, then run.

with settings as (
  select
    'you@example.com'::text as seed_email,
    '[SEED]'::text as seed_prefix
),
target_user as (
  select up.user_id
  from public.user_profiles up
  join settings s on lower(up.email) = lower(s.seed_email)
)
delete from public.tabular_reviews tr
using target_user tu, settings s
where tr.user_id = tu.user_id
  and tr.title like s.seed_prefix || '%';

-- If the result says "DELETE 0", either nothing matched seed_prefix or
-- seed_email didn't resolve to a user_profiles row — double-check both above.
