-- 0018_chat_message_citations.sql
--
-- Adds chat_messages.citations while retaining the v0.3 annotations column.
--
-- Upstream renamed annotations -> citations. Dev deploys migrations before
-- swapping the backend image, so a hard rename breaks the still-running v0.3
-- revision and makes rollback unsafe. Keeping both columns gives old and new
-- revisions a compatible database interface throughout the rollout.
--
-- This migration is also repair-safe for environments where an earlier
-- revision already performed the rename: it restores whichever column is
-- missing and backfills both directions.

alter table public.chat_messages
  add column if not exists annotations jsonb;

alter table public.chat_messages
  add column if not exists citations jsonb;

update public.chat_messages
set citations = annotations
where citations is null
  and annotations is not null;

update public.chat_messages
set annotations = citations
where annotations is null
  and citations is not null;

create or replace function public.sync_chat_message_citations()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.citations is null and new.annotations is not null then
      new.citations := new.annotations;
    elsif new.annotations is null and new.citations is not null then
      new.annotations := new.citations;
    elsif new.annotations is distinct from new.citations then
      -- citations is the canonical v0.4 field when a caller supplies both.
      new.annotations := new.citations;
    end if;
    return new;
  end if;

  if new.citations is distinct from old.citations
     and new.annotations is not distinct from old.annotations then
    new.annotations := new.citations;
  elsif new.annotations is distinct from old.annotations
        and new.citations is not distinct from old.citations then
    new.citations := new.annotations;
  elsif new.annotations is distinct from new.citations then
    new.annotations := new.citations;
  end if;

  return new;
end;
$$;

drop trigger if exists sync_chat_message_citations_trigger
  on public.chat_messages;

create trigger sync_chat_message_citations_trigger
before insert or update of annotations, citations
on public.chat_messages
for each row
execute function public.sync_chat_message_citations();
