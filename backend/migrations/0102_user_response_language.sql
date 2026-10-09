-- Dev numbered adaptation of upstream 663d3b16
-- (20261007_01_user_response_language.sql): response language preference
-- from Settings > Personalisation. 'auto' (the default) adds nothing to the
-- prompt; otherwise the value is a BCP 47 tag such as 'en-GB' or 'zh-Hans'.
-- The application owns the list of offered languages, so the constraint checks
-- the tag's shape rather than its value. Idempotent; the column inherits the
-- existing user_profiles table privileges (no new grants, no RLS).
--
-- Upstream deleted its dated file again in 190f0a2f while its code still read
-- the column, and later (8cc1ffcc) folds every response-style column into one
-- sparse jsonb column with a carry-over block. Dev's numbered history is
-- append-only: this migration stays, and the jsonb change lands as a later
-- numbered migration that carries this column across.
alter table public.user_profiles
  add column if not exists response_language text not null default 'auto';

alter table public.user_profiles
  drop constraint if exists user_profiles_response_language_check;
alter table public.user_profiles
  add constraint user_profiles_response_language_check
  check (
    response_language = 'auto'
    or response_language ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'
  );
