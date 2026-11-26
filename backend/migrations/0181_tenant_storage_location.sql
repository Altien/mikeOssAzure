-- Multi-tenant phase 3, issue 010 (docs/issues/multi-tenant/010-storage-per-tenant.md):
-- the tenant registry records where each tenant's files live.
--
-- Written by the external control plane (issue 018,
-- `cp_set_storage_location(tenant_id, account, container)`); this file only
-- adds the columns. The backend reads them for the current tenant
-- (backend/src/lib/tenantStorageLocation.ts) and routes every Blob call to
-- that location (backend/src/lib/storage.ts).
--
--   storage_account    Azure Storage account NAME (not a URL, not a key). The
--                      app reaches it as https://<name>.blob.core.windows.net
--                      with its managed identity. NULL: the install's
--                      configured account (AZURE_STORAGE_ACCOUNT_NAME /
--                      AZURE_STORAGE_CONNECTION_STRING).
--   storage_container  Container (bucket, on R2 installs) in that account.
--                      NULL: the install's configured container
--                      (AZURE_STORAGE_CONTAINER_NAME, default "documents").
--   region             Azure region the control plane placed the tenant in.
--                      Informational for the app.
--
-- Every column is NULL on existing rows, so single-tenant installs keep
-- today's account and container with no data copy. Idempotent.

alter table public.tenants
  add column if not exists storage_account text,
  add column if not exists storage_container text,
  add column if not exists region text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tenants'::regclass
       and conname = 'tenants_storage_account_format'
  ) then
    -- Azure account naming rule: 3-24 lowercase letters and digits.
    alter table public.tenants
      add constraint tenants_storage_account_format
      check (storage_account is null or storage_account ~ '^[a-z0-9]{3,24}$');
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tenants'::regclass
       and conname = 'tenants_storage_container_format'
  ) then
    -- Azure container naming rule: 3-63 lowercase letters, digits and single
    -- hyphens, starting and ending with a letter or digit.
    alter table public.tenants
      add constraint tenants_storage_container_format
      check (
        storage_container is null
        or (storage_container ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
            and position('--' in storage_container) = 0)
      );
  end if;
end
$$;

comment on column public.tenants.storage_account is
  'Azure Storage account name holding this tenant''s files; NULL = the install''s configured account. Set by the control plane (cp_set_storage_location).';
comment on column public.tenants.storage_container is
  'Container in storage_account; NULL = the install''s configured container. Set by the control plane (cp_set_storage_location).';
comment on column public.tenants.region is
  'Azure region the control plane placed this tenant in.';
