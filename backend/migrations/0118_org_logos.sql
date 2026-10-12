-- Adapted candidate from source d6356e3. Numbering is provisional until source index 85.
alter table public.organizations add column if not exists logo_updated_at timestamptz;

create table if not exists public.org_logos (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  object_key text not null unique,
  content_type text not null check (content_type in ('image/png','image/jpeg','image/webp')),
  updated_by text,
  updated_at timestamptz not null default now()
);

create or replace function public.sync_org_logo_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update public.organizations set logo_updated_at = null where id = old.org_id;
    return old;
  end if;
  update public.organizations set logo_updated_at = new.updated_at where id = new.org_id;
  return new;
end;
$$;
drop trigger if exists org_logos_sync_updated_at on public.org_logos;
create trigger org_logos_sync_updated_at after insert or update or delete on public.org_logos
for each row execute procedure public.sync_org_logo_updated_at();

-- Private PostgREST deployment: application authorization is enforced in the
-- backend; only the server/service role can access this metadata table.
revoke all on public.org_logos from public, web_anon, authenticated;
grant select, insert, update, delete on public.org_logos to service_role;
revoke all on function public.sync_org_logo_updated_at() from public, web_anon, authenticated;
grant execute on function public.sync_org_logo_updated_at() to service_role;
