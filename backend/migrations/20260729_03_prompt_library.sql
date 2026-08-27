create table if not exists public.saved_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prompt text not null,
  description text,
  prompt_type text,
  categories jsonb not null default '[]'::jsonb,
  practice_areas jsonb not null default '[]'::jsonb,
  source_requirements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_saved_prompts_user_updated
  on public.saved_prompts(user_id, updated_at desc);
alter table public.saved_prompts enable row level security;
revoke all privileges on table public.saved_prompts from anon, authenticated;
grant select, insert, update, delete on public.saved_prompts to service_role;
