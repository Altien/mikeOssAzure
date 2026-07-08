-- 0018_chat_message_citations.sql
--
-- Renames chat_messages.annotations -> citations.
--
-- Re-authored in dev's numbered style from upstream's date-based
-- `backend/migrations/20260704_01_chat_message_citations.sql` (commit
-- 82dcaefc430fe823499480a2ad669d51dad738d4, PR#206).
--
-- REQUIRED by the chat/* refactor adopted in a5fe6d6: the new
-- `lib/chat/contextBuilders.ts` reads `.select("id, content, citations")`
-- on chat_messages, but dev's 0000_initial.sql created the column as
-- `annotations jsonb`. This is a pure rename (data preserved), not a
-- drop/add, so it is safe per KNOWLEDGE §4.3. No Supabase coupling.
--
-- Idempotent: only renames when `annotations` still exists and `citations`
-- does not, so re-running (or running against an already-migrated DB) is a
-- no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'chat_messages'
      and column_name = 'annotations'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'chat_messages'
      and column_name = 'citations'
  ) then
    alter table public.chat_messages
      rename column annotations to citations;
  end if;
end $$;
