# Operator checks

Two checks that help an operator get a deployment working and keep it healthy.
Before sign-in is configured, the setup diagnostic at `https://<your-domain>/diag/setup`
shows which settings the deployment still needs.

## Health page

`https://<your-domain>/diag` checks the things that have broken real installs:
configuration, the Entra client secret and its expiry, redirect URIs, the database
roles and data assignment, migrations, storage, the job queue and provider
credentials. It is read-only and shows failures first, each with what to do. It does
not need sign-in, so it works during an expired-secret outage, when sign-in and
`/install` do not.

**It cannot diagnose a revision that fails its startup gates**, including the tenant
database startup check, because the page exists only once those gates have passed. For
a revision that never becomes ready, read that revision's console logs instead.

It has its own passphrase, `DIAGNOSTICS_HEALTH_TOKEN`, which opens this page only. The
`/postgrest` page, which writes, and `/inspect`, which returns rows, stay behind
`DIAGNOSTICS_TOKEN`. To use it:

1. Create a new backend revision with the env var `DIAGNOSTICS_HEALTH_TOKEN` set to a
   phrase of several words, as a secret reference. Do not reuse any other secret.
2. Go to `https://<your-domain>/diag` and type the passphrase. A script can post the
   form fields `passphrase` and `format=json` to the same address for the same results
   as JSON.

The passphrase is not in the URL, so it does not have to be removed for URL-logging
reasons. Removing the env var is still how you turn the page off.

The page exists only while the env var is set: without it, `/diag` answers 404. A wrong
passphrase gets 401 and the form again. After 10 wrong passphrases in 15 minutes the
page answers 429 for everyone, including someone with the right passphrase, until the
15 minutes are up or a new revision starts. The count is per replica, so with several
replicas the real limit is 10 for each. Anyone who can reach the address can use up the
count, so a lockout during an outage may not be your own typing. The page shows
counts, statuses, secret names and error codes, never secret values or rows. Most
checks run in the backend's identity; the secret expiry and redirect URI checks use
its managed identity to read the app registration through Graph. If that access is
missing, they report **info** with an unknown result, and the "Client secret accepted"
check still tests the secret itself.

Requests that arrive during a run share it, so reloading does not open more database
connections. Each check stops waiting after 10 s. Calls that take no cancel signal
(Key Vault, the storage listing, the managed identity token) are left to finish in the
background.

On a pooled stamp, "Client secret accepted" tests the External ID secret only, and says
so. The enterprise `entra-client-secret` is not tested, because its authority is
`organizations`, which a `client_credentials` request cannot use. "Client secret
expiry" reports info there.

**If the client secret has expired or is invalid** (AADSTS7000222 or AADSTS7000215):
create a new client secret on the app registration and write it as a new version of Key
Vault `entra-client-secret`. Do not re-run `create-entra-apps.ps1`. How it takes effect
depends on the backend, and the page says which applies:

- **No `ENTRA_CLIENT_SECRET` env var, or the placeholder `__unset__`:** the backend
  reads Key Vault through its config cache, so the new version takes effect within
  about 5 minutes (`CONFIG_CACHE_TTL_SECONDS` changes this), with no new revision
  needed.
- **`ENTRA_CLIENT_SECRET` set on the revision:** create a new backend revision, because
  the env reference wins over Key Vault and resolves only at revision start.

The same applies to other settings the page asks you to correct, with these exceptions:

- **The three `auth-*` keys:** the backend reads them once at startup, so they always need
  a new backend revision.
- **`jwt-secret`, `supabase-url` and `supabase-secret-key`:** the backend reads these only
  from its environment (`JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`), so they
  always need a new backend revision. The page looks in Key Vault as well, so it can show
  one as present while the running revision still has the old value or none.
- **`postgrest-jwt-secret`:** the backend picks up a new value within about 5 minutes, but
  PostgREST holds its copy, `PGRST_JWT_SECRET`, until its own revision restarts. Create a
  new PostgREST revision too, or the two sides stay mismatched.

**If the page says it could not read a setting from Key Vault, do not rotate the secret.**
That is an outage or an access problem, and says nothing about the secret. Check Key Vault
access first and reload the page. "has no value" appears only when the vault answered that
the setting is absent.

## Install tenant check

Migration 0176 assigns all existing data to one tenant, once: the oldest active
row in `public.tenants`, or `default` when that table is empty and data exists.
If that differs from the deployment's configured tenant (Key Vault
`entra-tenant-id`; on other auth modes `default-tenant-id`, or `default` when it
is not set), the data would belong to a tenant nobody signs in as, and re-running
migrations could not change it. The migration runner therefore makes the same
choice first and, if the two differ, fails with `Install tenant check failed`.

**What it means.** The migration failed before running anything: no migration
has run and the database is unchanged. If the migrations run as a separate job
during an upgrade, the previous backend keeps working, because neither it nor the
worker has been promoted. The migration log names both tenant values and why 0176
would choose its value.

The check does not run on a new database (no tenants, no data), when `default`
is both chosen and configured, or on a database already past 0176.

**How to resolve it.** Decide which value is correct. For a single-tenant
install, the configured value is normally correct, because it is the tenant your
users sign in to.

- **The configured tenant is correct** (the usual case). Connect to PostgreSQL
  as the server administrator, from a host that can reach the server, and make it
  the only active tenant:

  ```sql
  begin;
  insert into public.tenants (tenant_id, status)
    values ('<configured tenant>', 'active')
    on conflict (tenant_id) do update set status = 'active';
  update public.tenants set status = 'suspended'
    where tenant_id <> '<configured tenant>';
  commit;
  ```

  0176 assigns existing rows in the tables it adds `tenant_id` to, to this tenant,
  including anything created by users of the suspended tenants, whose access stops.
  Tables that already had `tenant_id`, such as the Skills tables, keep their
  value, so their rows stay under the suspended tenant. If more than one real tenant
  has data in this database, or those tables hold rows for a tenant you are
  suspending, stop: the data has to be split by hand before upgrading.
- **The database's value is correct.** Correct the Key Vault secret named in the
  message, and check first that the deployment is meant to use that tenant: on
  Entra this secret also decides who can sign in.

Then run the migrations again.
