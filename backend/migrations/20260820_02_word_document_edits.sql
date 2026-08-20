create table if not exists public.word_document_edits (
  id uuid primary key default gen_random_uuid(),
  word_chat_message_id uuid not null
    references public.word_chat_messages(id) on delete cascade,
  block_index integer not null check (block_index >= 0),
  original_text text not null check (length(original_text) > 0),
  replacement_text text not null default '',
  formats text[] not null default '{}',
  occurrence text check (occurrence is null or occurrence = 'all'),
  reason text,
  apply_mode text not null
    check (apply_mode in ('direct', 'approval')),
  apply_status text not null default 'proposed'
    check (apply_status in ('proposed', 'applied', 'unmanaged', 'failed')),
  resolution_status text
    check (resolution_status is null or resolution_status in ('accepted', 'rejected')),
  matched_occurrences integer check (matched_occurrences is null or matched_occurrences >= 0),
  applied_occurrences integer check (applied_occurrences is null or applied_occurrences >= 0),
  error_code text,
  error_message text,
  applied_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (word_chat_message_id, block_index),
  constraint word_document_edits_resolution_requires_application
    check (resolution_status is null or apply_status = 'applied')
);

create index if not exists word_document_edits_message_idx
  on public.word_document_edits(word_chat_message_id, block_index);

create index if not exists word_document_edits_unresolved_idx
  on public.word_document_edits(word_chat_message_id)
  where apply_status = 'applied' and resolution_status is null;

alter table public.word_document_edits enable row level security;
revoke all on public.word_document_edits from anon, authenticated;
grant select, insert, update, delete
  on public.word_document_edits
  to service_role;
