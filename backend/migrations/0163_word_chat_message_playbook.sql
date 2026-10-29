-- Dev forward candidate for source180 19fb8ea19d89cda5057508eaff1ddc3095b28bbb.
-- Dated source: backend/migrations/20261021_04_word_chat_message_playbook.sql
-- Provisional 180 order 2; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-21
-- A Word chat message can name the playbook the user attached, as a web chat
-- message already does (20261017_05), so the pill survives a reload.
alter table public.word_chat_messages add column if not exists playbook jsonb;

revoke all privileges on table public.word_chat_messages from public, web_anon, authenticated;
grant select, insert, update, delete on public.word_chat_messages to service_role;
notify pgrst, 'reload schema';
