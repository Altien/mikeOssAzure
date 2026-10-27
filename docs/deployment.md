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

Background jobs wait at most 60 seconds for a parser slot before downloading.
This keeps small-file batches moving; longer waits defer to Postgres for 30
seconds without spending retries. With parsing capped at five minutes, the
queue cannot consume the ten-minute claim lease. Interactive requests
can download three sources concurrently, matching tabular row concurrency;
only parsing is serial. Admission queues hold at most eight waiters; the parser deadline starts when
parsing starts, as in #721. Generic job concurrency does not create more slots.

Linux requires `prlimit` (util-linux), installed by the combined Dev Docker image and Nixpacks. Missing
`prlimit` fails extraction. Defaults:

| Limit | Setting |
| --- | --- |
| Parser time | `EXTRACTION_TIMEOUT_MS=180000`, capped at 300000 |
| Writable data, including native buffers | `EXTRACTION_MAX_MEMORY_MB=1024` MiB |
| Virtual address space | Data budget + 1024 MiB for runtime reservations |
| Source / returned text | 150 MiB / 16 MiB |

The JS heap is capped at half the data budget; glibc uses two malloc arenas to
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
