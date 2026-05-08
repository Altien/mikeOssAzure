create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique,
  status text not null default 'active'
    check (status = any (array['active','pending','suspended'])),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_group_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete cascade,
  group_object_id text not null,
  role text not null,
  created_at timestamptz not null default now(),
  unique(tenant_id, group_object_id)
);
