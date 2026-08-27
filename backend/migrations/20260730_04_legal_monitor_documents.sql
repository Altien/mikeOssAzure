create table if not exists public.legal_monitor_documents (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.legal_monitors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique(monitor_id, document_id)
);

create index if not exists idx_legal_monitor_documents_monitor
  on public.legal_monitor_documents(monitor_id, position);
create index if not exists idx_legal_monitor_documents_document
  on public.legal_monitor_documents(document_id);
create index if not exists idx_legal_monitor_documents_user
  on public.legal_monitor_documents(user_id);
alter table public.legal_monitor_documents enable row level security;
revoke all privileges on table public.legal_monitor_documents
  from anon, authenticated;
grant select, insert, update, delete
  on public.legal_monitor_documents to service_role;
