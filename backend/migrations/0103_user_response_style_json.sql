-- Dev numbered adaptation of upstream 8cc1ffcc (its in-place rewrite of
-- 20261006_01_user_response_style.sql): response style preferences from
-- Settings > Personalisation (verbosity, headers and lists, tone, language)
-- stored as one sparse JSON object.
--
-- One column rather than one per setting: the set is expected to grow, the
-- values are only ever read together to build a prompt, and nothing queries
-- them. A new setting therefore needs no migration. Only choices that differ
-- from the default are stored; defaults live in the backend
-- (modules/user/user.responseStyle.ts), which also validates every value.
--
-- Dev divergences (see UPSTREAM_SYNC_LOG.md, 8cc1ffcc):
-- - Dev's numbered history is append-only, so 0101/0102 stay and this
--   migration carries their draft columns (response_verbosity, _formatting,
--   _tone, _language) into the JSON column, as upstream's draft carry-over
--   does. The carry-over runs only in the run that creates response_style, so
--   a replay cannot resurrect a draft value the user has since reset.
-- - The draft columns are NOT dropped here (internal design notes §4.3): a later
--   numbered migration drops them once this one has been verified.
-- - merge_user_response_style takes a text actor ID (Dev's Entra oid compared
--   as text, as in the overview RPCs) and is executable by service_role only.
--   No RLS, no auth.users.
-- Idempotent.
do $$
declare
  creating boolean;
  draft record;
begin
  creating := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_profiles'
      and column_name = 'response_style'
  );

  alter table public.user_profiles
    add column if not exists response_style jsonb not null default '{}'::jsonb;

  if creating then
    for draft in
      select * from (values
        ('verbosity', 'response_verbosity', 'balanced'),
        ('formatting', 'response_formatting', 'balanced'),
        ('tone', 'response_tone', 'balanced'),
        ('language', 'response_language', 'auto')
      ) as d(key, col, def)
    loop
      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user_profiles'
          and column_name = draft.col
      ) then
        execute format(
          'update public.user_profiles
              set response_style = response_style || jsonb_build_object(%L, %I)
            where %I is distinct from %L
              and not response_style ? %L',
          draft.key, draft.col, draft.col, draft.def, draft.key
        );
      end if;
    end loop;
  end if;
end $$;

alter table public.user_profiles
  drop constraint if exists user_profiles_response_style_check;
alter table public.user_profiles
  add constraint user_profiles_response_style_check
  check (
    jsonb_typeof(response_style) = 'object'
    and octet_length(response_style::text) <= 2000
  );

-- Merges a change into one user's response style and returns the result, or
-- null when the user has no profile. A null value in the patch removes that
-- key, which is how a setting returns to its default. Merging in the database
-- keeps two quick changes to different settings from overwriting each other.
-- Authorization is the caller's: the backend passes the authenticated user id.
create or replace function public.merge_user_response_style(
  p_user_id text,
  p_patch jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  update public.user_profiles
     set response_style = jsonb_strip_nulls(response_style || p_patch),
         updated_at = now()
   where user_id::text = lower(p_user_id)
     and jsonb_typeof(p_patch) = 'object'
  returning response_style;
$$;

revoke all on function public.merge_user_response_style(text, jsonb)
  from public, web_anon, authenticated;
grant execute on function public.merge_user_response_style(text, jsonb)
  to service_role;
