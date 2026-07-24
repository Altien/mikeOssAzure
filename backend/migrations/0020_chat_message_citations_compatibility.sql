-- 0020_chat_message_citations_compatibility.sql
--
-- Repair migration for environments that already recorded the earlier
-- hard-rename version of 0018 as applied. Fresh upgrades get the same
-- compatibility behavior directly from 0018; this file makes the correction
-- reach databases whose migration ledger will not rerun that filename.

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
