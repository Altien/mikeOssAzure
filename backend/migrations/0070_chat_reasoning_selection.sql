-- Migration date: 2026-08-26

alter table public.user_profiles
  add column if not exists last_selected_reasoning_level text;

alter table public.chats
  add column if not exists reasoning_level text;

alter table public.word_chats
  add column if not exists reasoning_level text;

alter table public.user_profiles
  drop constraint if exists user_profiles_last_selected_reasoning_level_check;
alter table public.user_profiles
  add constraint user_profiles_last_selected_reasoning_level_check
  check (last_selected_reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));

alter table public.chats
  drop constraint if exists chats_reasoning_level_check;
alter table public.chats
  add constraint chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));

alter table public.word_chats
  drop constraint if exists word_chats_reasoning_level_check;
alter table public.word_chats
  add constraint word_chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
