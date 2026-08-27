-- Fork schema sync: fold schema.sql-only additions into a migration so
-- upgraded deployments converge with fresh installs.
--
-- Covers three changes that had landed in schema.sql without a dated
-- migration (drift caught by the schema-drift workflow):
--   1. contact_messages table (landing-page contact form)
--   2. chat_messages.playbook column (playbook runs from chat)
--   3. user_mcp_connectors stdio transport (managed local MCP connectors)
--
-- Idempotent: safe to re-run and safe on databases that already have some
-- of these objects.

-- 1. contact_messages --------------------------------------------------------

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  subject text,
  message text not null,
  source text not null default 'landing',
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists idx_contact_messages_created_at
  on public.contact_messages(created_at desc);

alter table public.contact_messages enable row level security;

revoke all on public.contact_messages from anon, authenticated;

-- The instance-wide `grant ... on all tables in schema public to
-- service_role` in schema.sql only covers tables that existed when it ran;
-- a table added later needs the grant repeated.
grant select, insert, update, delete
  on public.contact_messages to service_role;

-- 2. chat_messages.playbook --------------------------------------------------

alter table public.chat_messages
  add column if not exists playbook jsonb;

-- 3. user_mcp_connectors stdio transport -------------------------------------

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_mcp_connectors'::regclass
      and conname = 'user_mcp_connectors_transport_check'
  ) then
    alter table public.user_mcp_connectors
      drop constraint user_mcp_connectors_transport_check;
  end if;
end $$;

alter table public.user_mcp_connectors
  add constraint user_mcp_connectors_transport_check
  check (transport in ('streamable_http', 'stdio'));
