-- OSS-7 Skills: tenant GitHub OAuth connection for private read acquisition.

create table if not exists public.altien_skill_github_oauth_states (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  created_by text not null,
  state_hash text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists altien_skill_github_oauth_states_expiry_idx
  on public.altien_skill_github_oauth_states(expires_at);

create table if not exists public.altien_skill_github_connections (
  tenant_id text primary key references public.tenants(tenant_id) on delete cascade,
  encrypted_access_token text not null,
  access_token_iv text not null,
  access_token_tag text not null,
  github_user_id text,
  github_login text,
  granted_scopes text[] not null default '{}',
  connected_by text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

