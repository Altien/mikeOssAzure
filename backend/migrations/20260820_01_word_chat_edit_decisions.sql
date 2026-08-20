alter table public.word_chat_messages
  add column if not exists edit_decisions jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'word_chat_messages_edit_decisions_object_check'
      and conrelid = 'public.word_chat_messages'::regclass
  ) then
    alter table public.word_chat_messages
      add constraint word_chat_messages_edit_decisions_object_check
      check (jsonb_typeof(edit_decisions) = 'object');
  end if;
end;
$$;

create or replace function public.merge_word_chat_edit_decisions(
  p_user_id text,
  p_client_document_id uuid,
  p_message_id uuid,
  p_decisions jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer := 0;
begin
  if jsonb_typeof(p_decisions) <> 'object' then
    raise exception 'p_decisions must be a JSON object';
  end if;

  update public.word_chat_messages message
  set edit_decisions = coalesce(message.edit_decisions, '{}'::jsonb) || p_decisions
  from public.word_chats chat,
       public.word_documents document
  where message.id = p_message_id
    and message.role = 'assistant'
    and chat.id = message.chat_id
    and document.id = chat.word_document_id
    and chat.user_id::text = p_user_id
    and document.user_id::text = p_user_id
    and document.client_document_id = p_client_document_id;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.merge_word_chat_edit_decisions(
  text,
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated;
grant execute on function public.merge_word_chat_edit_decisions(
  text,
  uuid,
  uuid,
  jsonb
) to service_role;
