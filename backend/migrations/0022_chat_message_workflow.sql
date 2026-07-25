-- 0022_chat_message_workflow.sql
--
-- Chat routes persist the optional workflow selection with each user message.
-- The upstream-shaped route field existed before the local migration set
-- created its backing column, causing every ordinary user-message insert to
-- fail while the ignored error allowed the assistant turn to continue.

alter table public.chat_messages
  add column if not exists workflow jsonb;
