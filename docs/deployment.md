# Azure deployment

Use [Azure prerequisites](azure-prereqs.md) for self-host provisioning and [the deployment runbook](runbook-dev-deployment.md) for the maintained deployment process. The application uses Entra authentication, private Postgres/PostgREST, Azure Blob Storage, and organisation-managed model credentials.

## Database upgrades

Apply numbered files in backend/migrations/ using the migration runner. Fresh and existing databases use the same migration history; there is no standalone schema.sql bootstrap. Back up existing data, inspect the applied migration records, and run the documented migration command before starting a new version. Application boot reports outstanding migrations without applying them.

The runner records applied file names in `public.pgmigrations`, the single
authoritative history for Azure and local PostgreSQL. Numbered migration
0109 adds nullable SHA-256 checksums and removes application-role writes to
history. The internal service role retains SELECT for startup schema checks;
web_anon and authenticated have no bookkeeping access. No schema.sql or
parallel schema_migrations table is used.

Inspect an intended database before upgrading (set its direct owner connection
in DATABASE_URL, or the existing Managed Identity connection settings):

```bash
pnpm --dir backend migrate:dev status
pnpm --dir backend migrate:dev up
# Local Docker stack; also supports status/up and the recovery commands below:
pnpm --dir backend migrate:local status
```

The built deployment job runs `pnpm --dir backend migrate` (default `up`).
Status exits 0 when current, 2 for pending files, and 1 for changed, removed or
out-of-order history. It never provisions secrets, reloads PostgREST, syncs the
catalogue, creates history or applies SQL. Only successful `up` runs continue
through the existing deployment provisioning steps. Use a direct database
session, not a transaction pooler: status and upgrades hold the same advisory
lock as node-pg-migrate, including older jobs and its CLI.

Checksums use UTF-8 SQL with CRLF normalized to LF for Windows/Linux parity.
Newly executed files receive checksums after node-pg-migrate commits successfully.
Older applied records, manually recorded files and a job interrupted between
migration commit and checksum recording remain explicitly **unverified**.
Their original bytes cannot be reconstructed, so the runner never fills them
in silently or replays them. Status reports their count; unverified historical
checksums alone do not block an upgrade. Changed or removed recorded files and
insertions before applied history block `up`: restore the shipped files,
inspect deployment records and use a new numbered migration for corrections.

Ordinary files run in a native node-pg-migrate transaction with their history
row. A failure rolls back that file and leaves it pending; previously committed
files stay recorded and later files do not run. Historical SQL containing its
own BEGIN/COMMIT remains unchanged: those files may leave partial changes on
failure and their file/history atomicity is not guaranteed. Back up data,
inspect the failure and restore or complete that SQL deliberately before using
explicit mark recovery. Never edit or rename shipped migration files.

The outer session lock stays held across history checks, every file and checksum
recording. A concurrent runner polls pg_try_advisory_lock without retaining a
blocking query snapshot, names the holder when visible, then re-reads history
after acquiring the lock. MIGRATE_LOCK_WAIT bounds the wait in whole seconds
(default 900; 0 fails immediately). Migration sessions are named mike-migrate.
The runner resets settings, role/session authorization and transient session
state between files without releasing the advisory lock.

Supply a direct or session-pooler owner connection. Port 6543 and explicit
transaction-pooler URL indicators are refused; poolers on custom ports must
still be configured in session mode. On a busy database, a connection-time
PGOPTIONS='-c lock_timeout=10s' bounds waits for table locks.

The installed node-pg-migrate 7.x SQL loader has no noTransaction annotation.
No current numbered file requires one. The runner clearly rejects CONCURRENTLY
and -- migrate:no-transaction forms rather than silently wrapping them. Adopt
an explicit native runner mechanism before introducing such a migration.

Recovery is explicit and never part of normal startup or deployment:

```bash
# Only after independently verifying every file through this exact filename ran:
pnpm --dir backend migrate:dev baseline 0000_initial.sql --confirm-applied
# Record one file applied by hand; it must be the next pending file:
pnpm --dir backend migrate:dev mark 0001_tenant_policy.sql --confirm-applied
```

These commands use node-pg-migrate's existing history, execute no migration SQL,
and leave checksums NULL. Baseline records only pending files at or below the
explicit filename, never files above it; ordinary `up` never baselines. An existing public schema with no pgmigrations
history is refused by status/up/mark until a confirmed bounded baseline records
its independently verified provenance. Truly empty databases initialize normally.
New and existing databases both execute pending numbered files. A fresh successful
install therefore reports no pending files without a hand-maintained manifest.
Direct `migrate:legacy`/`migrate:down` commands remain operator escape hatches
and bypass these integrity checks; production corrections are forward-only.

Identity values are Entra text IDs. Database roles and grants are explicit: the API uses its service role, while anonymous access is restricted. Preserve those grants when adding tables or RPCs.

The Azure `db-migrate` Container App job applies the numbered schema, refreshes
PostgREST's schema cache, and ingests the Mike workflow catalogue before the
new backend revision is activated. It uses the private PostgREST endpoint,
the same user-assigned identity as the backend for Key Vault and Blob Storage,
and the `workflowRepository`/`workflowRef` deployment parameters. Pin
`workflowRef` to a full commit for reproducible releases. Reference uploads
must finish before the database switches active catalogue rows. A failed
download, upload or replacement fails the job and leaves the previous active
catalogue usable; do not bypass the job during deployment.

### Install is behind on migrations

A backend started against a database that is missing some of
`backend/migrations/` keeps running, but anything that needs a missing
function, table or column fails. Requests answer `503` with code
`schema_out_of_date` ("The server's database needs an update"), and the
backend logs `[http/schema-out-of-date]` or `[schema-out-of-date]` warnings
naming the PostgREST/SQLSTATE code (`PGRST202` function, `PGRST204` column,
`PGRST205` table, `42P01` relation). With error reporting on, Sentry shows a
warning titled `Failure in <operation> / … / schema_out_of_date / <code>`,
for example `Failure in maintenance.document_text / stale-sweep /
schema_out_of_date / PGRST202`; background sweeps report it once per process
and operation, so its event count does not measure how often it happens. Run
`pnpm --dir backend migrate:dev status` to list what is pending, apply it with
`pnpm --dir backend migrate:dev up` or the `db-migrate` job (which also reloads
the PostgREST schema cache), and restart the backend.

### Before upgrading: secrets copied from the template

The backend refuses to start when `DOWNLOAD_SIGNING_SECRET` or
`USER_API_KEYS_ENCRYPTION_SECRET` still holds the `backend/.env.example`
placeholder, or any value shorter than 32 characters. A deployment that copied
the template verbatim was running with publicly known secrets: download and
blob tokens could be forged, and user-supplied provider API keys were
encrypted under a key derived from a public string. The startup error names
the variable; generate a real value for each and restart:

```bash
openssl rand -hex 32   # once per variable
```

Both variables may also be left unset: the download and API-key features then
fail on first use, as before. Changing `USER_API_KEYS_ENCRYPTION_SECRET` on an
install that already stored user API keys makes those keys unreadable, so
users will have to enter them again.

### Upgrade order and rollback

<!-- Upstream dbc3c927 (PR #749 upgrade notes), adapted: Dev upgrades through
the numbered migration runner and the Azure db-migrate job, not migrate.sh,
schema.sql or Compose's db-init/workflow-sync services. -->
For the SQL/backend/web/Word performance changes in upstream PR #749, upgrade
an existing installation in this order:

1. Back up the database and retain the currently deployed image tags or Git
   commit. Let active assistant turns finish before restarting their backend;
   their resumable stream buffers live in that process.
2. Apply the pending numbered migrations (`pnpm --dir backend migrate:dev up`,
   or the `db-migrate` job), then run `status` and require no pending files.
   The new project-directory search requires `search_project_directory`, and
   paginated participation requires the new `get_projects_overview` argument.
   Starting the new backend before these migrations makes those requests fail.
3. Make sure PostgREST's schema cache was reloaded and the workflow catalogue
   synced (the `db-migrate` job does both), then deploy the backend and any
   separate workers.
4. Deploy the frontend and Word add-in. Check project-directory search,
   document conversion completion, and reopening an existing Word chat.

Manually or independently hosted components need the same ordering. A new
frontend can poll an older backend using individual document reads when its
batch endpoint is unavailable. Older API clients can still request
`/api/projects?include=documents` without pagination; new clients should send
`limit` and `offset` explicitly.

The migrations in this release retain the previous backend's project RPC call
shapes. A backend rollback leaves the migration history and schema in place;
do not delete `public.pgmigrations` rows or replay old migrations to undo an
application deployment. Validate a rollback against a copy of the database
before using it on a deployment that has accepted new writes.

Word's released device-only database remains at IndexedDB version 4, so an
older pane can still save an answer after another pane loads the new code.
Existing v4 databases retain their history-listing path; fresh v4 databases
include the optional recency index. PR preview builds used version 5: the new
add-in can read those databases in place, but a rollback to a released v4-only
bundle cannot. Keep a compatible add-in build for those devices. Do not clear
browser/add-in storage to resolve a version error: device-only chats have no
durable server copy.

## Tenancy mode

Every normal install (Azure Marketplace, local stack) is one
single system: tenancy mode `single`. You do not have to configure it. The
backend selects `single` when neither `TENANCY_MODE` nor `KEY_VAULT_NAME` is
set, and when the Key Vault has no `tenancy-mode` secret. A Key Vault that
cannot be read (unreachable, access denied, outage) stops startup instead of
falling back to `single`.

`pooled` (many customer tenants on one regional stamp) is opt-in. Set the
`tenancy-mode` Key Vault secret or the `TENANCY_MODE` environment variable to
`pooled`; the environment variable wins over the secret. Pooled stamps also
need the stamp, identity and control-plane configuration in the
[regional stamp runtime contract](multi-tenant/regional-stamp-runtime.md).

The mode is fixed at deployment time. The migration job records it in the
database (`app.install_tenancy`). The API and worker start only if their mode
agrees with the database, and they keep that mode until restart, so editing
the secret later changes nothing. Deployment setup refuses to turn a pooled
database back into a single install. Changing the mode means a redeploy, not
a configuration edit.

What `single` means:

- One install tenant owns all data: `DEFAULT_TENANT_ID` (default `default`)
  with local or Supabase sign-in, or the Entra directory tenant ID with Entra
  sign-in. The API and worker register it at startup with local or Supabase
  sign-in; with Entra the existing tenant onboarding creates it.
- Forced row-level security stays on as defence in depth. Single installs keep
  the `TENANT_RLS_ENFORCED=false` rollback switch; pooled startup refuses it.
- No multi-tenant setup is needed or used: no control plane, stamp ID or
  region, credit prices or budgets, or tenant-admin roles. Model calls are
  recorded in the usage ledger but never reserve or spend credits. The
  `/install` operator surface stays available; pooled stamps return 404 for
  it.

## Runtime configuration and credentials

The frontend is statically exported and reads public identity/API configuration at runtime. Follow the deployment runbook for routing its assets and the backend /config endpoint; do not replace this with a Next.js production server or bake secrets into browser bundles.

Store model credentials in Key Vault with local environment fallback. Azure OpenAI requires its deployment, endpoint, API version, and API key; managed identity access to Key Vault does not imply managed identity authentication to model inference. OpenRouter uses openrouter-api-key; Vercel AI Gateway accepts ai-gateway-api-key or the legacy vercel-ai-gateway-api-key alias.

An explicitly confirmed baseline must match the objects actually present.
Canonical history/checksum validation does not certify absent historical SQL
objects: investigate any prerequisite failure before recording provenance.
Recover through the documented numbered-migration process; never replay
`schema.sql`, rewrite applied files, or edit `pgmigrations` by hand.

### After the organization-access upgrade: `tabular_review_legacy_shares`

`0084_organization_legacy_sharing_backfill.sql` converts the old roleless
`shared_with` arrays into real access grants. One shape has nowhere to go: a
tabular review that lives INSIDE a project now inherits access from that
project, so a share on the review alone cannot be reproduced without handing
the recipient the whole matter. That migration dropped
`tabular_reviews.shared_with` without recording those recipients.

`0093_organization_access_followup.sql` creates
`public.tabular_review_legacy_shares` as the place those `(review, project,
email)` triples belong, and backfills it only if the `shared_with` column
still exists when it runs. On a deployment that already applied
`the original import` the column is gone, so the table lands EMPTY: the recipients
are recoverable only from a pre-upgrade backup. To recover them, restore the
old `shared_with` values into a scratch column named `shared_with` on
`tabular_reviews`, re-run `0093` (it is safe to re-run), then drop the
scratch column. Fresh installs create the table empty and nothing writes it
at runtime. The table carries no foreign keys, so the record survives the
review or project being deleted. It is `service_role`-only; read it with the
service key:

```sql
select l.email, l.project_id, l.tabular_review_id, l.archived_at
from public.tabular_review_legacy_shares l
order by l.archived_at desc;
```

Each row is a person who could see that review before the upgrade and cannot
now. For each one, decide deliberately: grant them access to the project (or
add them to the organization) if they should still have it, and otherwise do
nothing. The table is a record, not a queue â€” nothing reads it, and rows may
be deleted once every recipient has been dealt with.

Apply the workflow catalog migration before deploying the matching backend
release, then run the dedicated ingestion job from the built backend artifact:

User credential settings are read-only. Model and router selections remain user preferences. For the Word add-in, configure its public HTTPS origin and CORS and Entra redirect URIs as described in [Word deployment](word-addin-development.md#production-build).

LibreOffice must be available for DOC/DOCX conversion. See [Troubleshooting](troubleshooting.md), [Safe local testing](safe-local-testing.md), and the [security policy](../SECURITY.md).

## Document parsing resources

Indexing, chat reads, tabular sources, and legacy text precomputation share one
parser process per calling thread. It stays warm between files and recycles
after 200 files or 60 seconds idle, matching #721's worker reuse. Failures and
timeouts also retire it. On POSIX, retirement kills the process group, including
LibreOffice descendants, and removes its temporary directory.

Background jobs share one source-loading slot and wait at most 60 seconds total
for admission and parsing capacity; longer waits defer to Postgres for 30 seconds
without spending retries. Parsing is capped at five minutes, below the ten-minute
claim lease. Inline indexing waits for capacity when the queue runner is disabled.
Interactive requests can download three sources concurrently, matching tabular
row concurrency, and take priority over queued background parses. Background I/O
does not occupy the parser or the interactive admission queue (eight waiters).
Only parsing is serial; its deadline starts when parsing starts, as in #721.
Source downloads from S3-compatible storage abort after
`STORAGE_DOWNLOAD_TIMEOUT_MS` (default 120000), so a stalled read releases its
admission slot instead of holding it indefinitely.
Generic job concurrency does not create more parser slots.

Linux requires `prlimit` (util-linux), installed by the combined Dev Docker image and Nixpacks. Missing
`prlimit` fails extraction. Defaults:

| Limit | Setting |
| --- | --- |
| Parser time | `EXTRACTION_TIMEOUT_MS=180000`, capped at 300000 |
| Writable data, including native buffers | `EXTRACTION_MAX_MEMORY_MB=1024` MiB |
| Virtual address space | Data budget + 1024 MiB for runtime reservations |
| Source / returned text | 150 MiB / 16 MiB |

The JS heap keeps the configured memory budget (1024 MiB by default); glibc uses two malloc arenas to
avoid excessive virtual reservations. OS limits apply **per process**, including
conversion children, not to their aggregate usage. Set container/cgroup limits
for the whole service. macOS/Windows retain heap, input/output and time bounds,
but lack the Linux OS-memory guarantee. Decompression is covered by parser
memory/time limits; there is no separate ZIP preflight.

The deadline covers parsing, not storage/database I/O. No new migration is
needed beyond #721's `0173_document_text_failed_jobs.sql`.
`EXTRACTION_ISOLATION=off` bypasses subprocess protection for tests/emergencies.

## Durable background work

Azure runs `QUEUE_DRIVER=postgres` against the private PostgREST service. The
API uses `WORKERS_MODE=none`; a separate no-ingress worker Container App runs
`node dist/worker.js` with at least one replica, the same managed identity,
Key Vault and storage access, and the same backend image. The migration job
must apply numbered `0074_db_jobs.sql` before either app starts. Redis/BullMQ
remains optional for other deployments. The worker checks required secrets and
queue schema before reporting readiness; a failed initialization exits.


### Optional Supabase authentication recovery

For deployments that explicitly select Supabase authentication, SAML SSO can
be enabled with `SSO_ENABLED=true` after configuring the domain provider in
GoTrue. The progressive SSO page accepts an email address and derives its
domain; `SSO_ALLOWED_DOMAINS` accepts exact DNS domains.
The backend starts SSO with a one-use, browser-bound PKCE state and exchanges
the callback server-side before issuing the normal HttpOnly session cookie.
Entra and local authentication do not use this GoTrue configuration.

When runtime `/config` selects Supabase authentication, confirmation and password recovery use the frontend `/auth/callback` URL. Allow that exact URL in Supabase Auth, configure SMTP and the Site URL, and use a minimum password length of 10. Recovery responses intentionally do not reveal whether an account exists. Secure email changes require both addresses to confirm; expired links must be requested again. Entra and local deployments continue using their configured identity flow. These routes do not provision Supabase Auth or its database triggers in the Azure database.
