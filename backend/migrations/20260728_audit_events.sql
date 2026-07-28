-- Audit history of user actions (Clue custom; queried via the service-role
-- backend only — no RLS policies needed, like other app tables).
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null,
  user_email text,
  action text not null,          -- chat.message | document.uploaded | document.generated | document.edited | workflow.applied | tabular.created | tabular.generated | export.chats | export.account | export.tabular
  status text not null default 'completed',  -- completed | cancelled | failed
  title text,
  surface text,                  -- assistant | project | tabular | workflows | account
  project_id uuid,
  chat_id uuid,
  document_id uuid,
  review_id uuid,
  model text,
  detail jsonb
);
create index if not exists audit_events_user_created on public.audit_events (user_id, created_at desc);
create index if not exists audit_events_project_created on public.audit_events (project_id, created_at desc);
