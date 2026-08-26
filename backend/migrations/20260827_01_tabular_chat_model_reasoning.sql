-- Migration date: 2026-08-27

-- Tabular conversations choose their own interactive model and reasoning
-- level. These settings are independent from the model pinned to the review
-- for bulk extraction and regeneration work.
alter table public.tabular_review_chats
  add column if not exists model text,
  add column if not exists reasoning_level text;

-- Preserve the model that existing chats historically used. Fall back to the
-- owner's last-selected chat model only for reviews without a pinned model.
update public.tabular_review_chats as chat
set model = coalesce(
  review.model,
  (
    select profile.last_selected_chat_model
    from public.user_profiles as profile
    where profile.user_id = chat.user_id
  )
)
from public.tabular_reviews as review
where chat.review_id = review.id
  and chat.model is null;

-- The former tabular composer always initialized reasoning at High.
update public.tabular_review_chats
set reasoning_level = 'high'
where reasoning_level is null;

alter table public.tabular_review_chats
  drop constraint if exists tabular_review_chats_reasoning_level_check;
alter table public.tabular_review_chats
  add constraint tabular_review_chats_reasoning_level_check
  check (reasoning_level in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
