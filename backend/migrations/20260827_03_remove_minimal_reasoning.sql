-- Migration date: 2026-08-27

-- Minimal reasoning is inconsistently supported across providers. Migrate old
-- selections to Low and remove Minimal from every persisted preference union.
update public.user_profiles
set last_selected_reasoning_level = 'low'
where last_selected_reasoning_level = 'minimal';

update public.chats
set reasoning_level = 'low'
where reasoning_level = 'minimal';

update public.word_chats
set reasoning_level = 'low'
where reasoning_level = 'minimal';

update public.tabular_review_chats
set reasoning_level = 'low'
where reasoning_level = 'minimal';

alter table public.user_profiles
  drop constraint if exists user_profiles_last_selected_reasoning_level_check;
alter table public.user_profiles
  add constraint user_profiles_last_selected_reasoning_level_check
  check (last_selected_reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.chats
  drop constraint if exists chats_reasoning_level_check;
alter table public.chats
  add constraint chats_reasoning_level_check
  check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.word_chats
  drop constraint if exists word_chats_reasoning_level_check;
alter table public.word_chats
  add constraint word_chats_reasoning_level_check
  check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.tabular_review_chats
  drop constraint if exists tabular_review_chats_reasoning_level_check;
alter table public.tabular_review_chats
  add constraint tabular_review_chats_reasoning_level_check
  check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
