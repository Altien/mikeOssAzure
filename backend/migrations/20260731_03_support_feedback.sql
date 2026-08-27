create table if not exists public.support_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  type text not null check (type in ('bug', 'feature', 'question', 'other')),
  subject text not null,
  message text not null,
  link text,
  created_at timestamptz not null default now()
);

alter table public.support_feedback enable row level security;
revoke all privileges on table public.support_feedback from anon, authenticated;
grant select, insert, update, delete on public.support_feedback to service_role;
