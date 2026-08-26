-- Migration date: 2026-08-27

-- AI SDK 7 includes Max reasoning, and GPT-5.6 models expose it in place of
-- Minimal. Keep every persisted chat surface on the same explicit union.
alter table public.user_profiles
  drop constraint if exists user_profiles_last_selected_reasoning_level_check;
alter table public.user_profiles
  add constraint user_profiles_last_selected_reasoning_level_check
  check (last_selected_reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.chats
  drop constraint if exists chats_reasoning_level_check;
alter table public.chats
  add constraint chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.word_chats
  drop constraint if exists word_chats_reasoning_level_check;
alter table public.word_chats
  add constraint word_chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.tabular_review_chats
  drop constraint if exists tabular_review_chats_reasoning_level_check;
alter table public.tabular_review_chats
  add constraint tabular_review_chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
