alter table public.user_profiles
  add column if not exists email_integration_enabled boolean not null default false;

create table if not exists public.gmail_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  encrypted_refresh_token text not null,
  iv text not null,
  auth_tag text not null,
  scopes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gmail_oauth_states (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gmail_oauth_states_expiry
  on public.gmail_oauth_states(expires_at);
alter table public.gmail_connections enable row level security;
alter table public.gmail_oauth_states enable row level security;
revoke all privileges on table public.gmail_connections,
  public.gmail_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.gmail_connections,
  public.gmail_oauth_states to service_role;
