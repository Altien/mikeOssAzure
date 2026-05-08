# Local development stack — step by step

Stand up the **whole backend and frontend** against Docker on your
laptop: Postgres 16, PostgREST v12.2.3, Azurite playing the part of
Azure Blob Storage, the Node backend, and the Next.js dev server.
No reverse proxy, no hosted dependencies, no Azure account, no
internet access required after the initial install.

The schema is the same one Azure runs. The auth provider switches
to a local HS256 mode (or Microsoft Entra ID — see
[`runbook-entra-local-auth.md`](./runbook-entra-local-auth.md)).

## What this gives you

| Layer | What runs | How code reaches it |
|---|---|---|
| Postgres 16 | `mike-postgres` | `postgres://mikeadmin:devpassword@localhost:5432/mike` |
| PostgREST v12.2.3 | `mike-postgrest` | `http://localhost:4000` (backend hits this directly) |
| Azurite (Blob) | `mike-azurite` | `http://localhost:10000/devstoreaccount1` |
| Schema | `backend/migrations/0000_initial.sql` (via node-pg-migrate) | applied with `npm run migrate` from `backend/` |
| Roles | `authenticator`, `web_anon`, `authenticated`, `service_role` | created by `scripts/local-stack/00-init-roles.sql` on first init |
| Backend auth | `AUTH_PROVIDER=local` (HS256 against `JWT_SECRET`) | `backend/src/lib/auth/providers/local.ts` |

## What this does **not** give you

- **Local mode is not Entra.** This runbook uses `AUTH_PROVIDER=local`
  and HS256 tokens for the fastest Docker data-plane loop.
- **Entra local login is documented separately.** The frontend/backend
  can now run with `AUTH_PROVIDER=entra` and authenticate through
  Microsoft using the backend-owned provider-selection flow. See
  `docs/runbook-entra-local-auth.md`.
- **Full authenticated data-flow validation is still a follow-up.**
  Microsoft login was validated locally on 2026-05-05, but the broader
  project/document workflows still need to be exercised against the
  current local PostgREST/Azurite stack before calling the migration
  complete.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2).
- Node 22 + npm — for `npm run migrate` and the JWT helper.
- `psql` on PATH (optional, but useful).
- Repo cloned.

## One-time setup

```bash
# 1. Pick a JWT signing secret and add it to backend/.env.
#    PostgREST and the backend MUST share this value.
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")
echo "JWT_SECRET=$JWT_SECRET" >> backend/.env

# Export for the current shell session — needed when bringing the
# stack up so PostgREST gets the right value (see below).
export JWT_SECRET
```

On Windows PowerShell:
```powershell
$env:JWT_SECRET = node -e "console.log(require('crypto').randomBytes(36).toString('base64'))"
Add-Content backend/.env "JWT_SECRET=$env:JWT_SECRET"
```

## Bring the stack up

> **JWT_SECRET must be exported in your shell before running compose.**
> PostgREST reads `PGRST_JWT_SECRET: ${JWT_SECRET}` at container start.
> If you run compose without it set, PostgREST uses the fallback default
> and will reject every JWT you mint. If you miss this, restart PostgREST:
> ```bash
> JWT_SECRET="<your-secret>" docker compose -f docker-compose.dev.yml up -d --force-recreate postgrest
> ```

If you already have Azurite running (e.g. from Docker Desktop), omit it
to avoid a port conflict:
```bash
# Full stack (Azurite included):
JWT_SECRET="$JWT_SECRET" docker compose -f docker-compose.dev.yml up -d

# Azurite already running elsewhere — skip it:
JWT_SECRET="$JWT_SECRET" docker compose -f docker-compose.dev.yml up -d postgres postgrest
```

What happens on first boot:

1. `mike-postgres` initialises a fresh data volume and runs everything
   in `/docker-entrypoint-initdb.d/` — `00-init-roles.sql`. That
   creates `authenticator`, `web_anon`, `authenticated`, and
   `service_role` plus the `ALTER DEFAULT PRIVILEGES` so future
   migration tables are auto-granted.
2. `mike-postgrest` waits for Postgres to be healthy, connects as
   `authenticator`, serves on :3000 (host :4000). The backend hits
   this directly; the supabase-js client's hard-coded `/rest/v1`
   prefix is stripped by the wrapper in
   `backend/src/lib/supabase.ts` (the same wrapper used in entra
   mode for the deployed PostgREST).
3. `mike-azurite` exposes Blob/Queue/Table on :10000-10002.

Verify everything is up:

```bash
docker compose -f docker-compose.dev.yml ps
curl -s http://localhost:4000/                            # PostgREST root
curl -s http://localhost:10000/devstoreaccount1?comp=list # Azurite
psql "postgres://mikeadmin:devpassword@localhost:5432/mike" -c "\dt public.*"
# Expected: no tables yet — schema has not been applied.
```

## Create the Azurite blob container (one-time)

Azurite starts empty. The backend expects a `documents` container.
Use Node (not `az` CLI — it may resolve to your real Azure account):

```bash
cd backend
node -e "
const { BlobServiceClient } = require('@azure/storage-blob');
BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
  .getContainerClient('documents').createIfNotExists()
  .then(() => console.log('documents container ready'))
  .catch(e => console.error(e.message));
"
cd ..
```

## Apply / update the schema

> **Run this step on first setup AND every time a new migration file is added to `backend/migrations/`.**
> It is not a one-time action — any pull that adds a `.sql` file requires a re-run against your local DB.

`npm run migrate` doesn't resolve the binary on Windows. Use `npx`:

```bash
cd backend
DATABASE_URL="postgres://mikeadmin:devpassword@localhost:5432/mike" \
  npx node-pg-migrate up --migrations-dir migrations --migration-file-language sql
cd ..
```

`node-pg-migrate` tracks applied migrations in the `pgmigrations` table and skips anything already run, so it is safe to run repeatedly — only new files are applied.

Verify:

```bash
psql "postgres://mikeadmin:devpassword@localhost:5432/mike" -c "SELECT name, run_on FROM pgmigrations ORDER BY run_on;"
# Expected: one row per migration file, each with a timestamp.
```

Because role default privileges were set *before* the migration ran,
every newly-created table is automatically granted to `web_anon`
(SELECT) and `authenticated` (CRUD).

## Mint two JWTs

The backend needs **two** JWTs, both signed with the same `JWT_SECRET`:

1. A **service-role token** that supabase-js sends as its API key
   (lives in `backend/.env` as `SUPABASE_SECRET_KEY`).
2. A **user token** for testing your routes.

```bash
# 1. Service-role token (10 years), paste into backend/.env.
JWT_SECRET="$JWT_SECRET" node scripts/local-stack/forge-jwt.mjs \
  --role service_role \
  --sub backend \
  --hours 87600
# → SUPABASE_SECRET_KEY=<paste this>

# 2. User token for hitting routes.
TOKEN=$(JWT_SECRET="$JWT_SECRET" node scripts/local-stack/forge-jwt.mjs \
  --role authenticated \
  --sub 00000000-0000-0000-0000-000000000001 \
  --hours 8)
echo "$TOKEN"
```

The helper has zero npm dependencies — Node stdlib `crypto` produces
the HS256 signature.

## Smoke-test PostgREST directly

Useful when debugging policy / grants without the backend in the
loop:

```bash
# Insert a project as the authenticated user.
curl -s -X POST "http://localhost:4000/projects" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"user_id":"00000000-0000-0000-0000-000000000001","name":"Local smoke test"}'

# Read it back.
curl -s "http://localhost:4000/projects?select=id,name,created_at" \
  -H "Authorization: Bearer $TOKEN"
```

A 200 with a JSON row confirms the full pipe: Postgres running,
schema applied, role grants correct, PostgREST trusting the JWT.

## Run the backend against the stack

Set up `backend/.env` from the example, then fill in the four
local-mode values:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env:
#   AUTH_PROVIDER=local
#   JWT_SECRET=<your generated secret>
#   SUPABASE_URL=http://localhost:4000
#   SUPABASE_SECRET_KEY=<service-role JWT from above>
#   AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true
#   AZURE_STORAGE_CONTAINER_NAME=documents
#   FRONTEND_URL=http://localhost:3000
#   DOWNLOAD_SIGNING_SECRET=<openssl rand -base64 32>
#
# Plus at least one LLM provider key:
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
#   GEMINI_API_KEY=...
```

Then:

```bash
cd backend
npm install   # first time only
npm run dev   # → listens on :3001
```

End-to-end smoke test (verified working 2026-05-05):

```bash
# /health — unauthenticated
curl -fsS http://localhost:3001/health
# → {"ok":true}

# GET /projects — authenticated, returns [] initially
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/projects
# → []

# POST /projects — creates a row, returns the full object
curl -s -X POST http://localhost:3001/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke test"}' | head -c 200
# → {"id":"...","name":"Smoke test","user_id":"...","documents":[],...}
```

All three ✓ = backend boot ✓, local auth ✓, supabase-js →
PostgREST ✓, schema/grants ✓, Azurite blob container ✓.

## Run the frontend against the stack

In a second terminal:

```bash
cp frontend/.env.local.example frontend/.env.local
# Edit frontend/.env.local — only one variable matters for local dev:
#   NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
#
# Provider mode (local / entra / supabase) and any provider-specific
# values are now served at runtime from the backend's GET /config —
# no NEXT_PUBLIC_AUTH_PROVIDER, no NEXT_PUBLIC_ENTRA_*.

cd frontend
npm install        # first time only
npm run dev        # → listens on :3000
```

Open `http://localhost:3000`. The frontend fetches `/config` from
the backend on mount and switches to the right login UI based on
`AUTH_PROVIDER` in `backend/.env`. With `AUTH_PROVIDER=local`,
clicking "Continue locally" against any email mints a JWT and
signs you in.

To validate the full vertical:

```bash
# Sanity check /config from the backend
curl -s http://localhost:3001/config
# → {"authProvider":"local","entra":{"tenantId":"","clientId":""}}
```

## Resetting

Wipe everything (data volume included):

```bash
docker compose -f docker-compose.dev.yml down -v
```

Re-run "Bring the stack up" + "Apply the schema" from scratch.

## Where this fits in the development loop

```
write code  ──►  npm run dev (backend) ──►  curl localhost:3001/...
                       │
                       ├─ data → supabase-js → fetch wrapper strips
                       │   /rest/v1 → http://localhost:4000 →
                       │   postgrest → postgres
                       │
                       ├─ blob → @azure/storage-blob → http://localhost:10000
                       │   → azurite
                       │
                       └─ auth → AUTH_PROVIDER=local
                          → HS256 verify against JWT_SECRET
```

The stack stays up; iterate the code; commit + push when ready.

## What this gives you that Azure does NOT

- **Faster inner loop.** Saving a backend file restarts the dev
  server in ~200ms; the equivalent Azure round-trip (build +
  push + revision) is ~5 minutes.
- **No subscription costs.** Everything runs on Docker.
- **Offline development.** After the initial `npm install`, no
  outbound traffic is required.

## What this does NOT give you

- **Network isolation parity with Azure.** Local Postgres is
  reachable from anywhere on the host; the Azure deployment uses
  private endpoints and an internal-only PostgREST.
- **Microsoft Entra sign-in by default.** This runbook uses
  `AUTH_PROVIDER=local`. To validate Entra sign-in locally
  without Azure infrastructure, see
  [`runbook-entra-local-auth.md`](./runbook-entra-local-auth.md).
- **Azure-specific runtime concerns.** Managed Identity,
  Application Insights, Container Apps scaling — none of these
  exist in the local stack. They are validated against the deployed
  environment.

For the full Azure deployment guide (no Bicep needed), see
[`azure-prereqs.md`](./azure-prereqs.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `mike-postgrest` keeps restarting | role bootstrap didn't run (existing volume) | `docker compose down -v` then `up -d` |
| PostgREST returns 401 on every request | `JWT_SECRET` mismatch between compose env and forge-jwt | re-export `JWT_SECRET`, restart `mike-postgrest`, re-mint token |
| `npm run migrate` says "relation pgmigrations already exists" | you're re-running against a non-clean DB | that's fine — it skips applied migrations |
| `permission denied for table X` after migration | migration ran as a role other than `mikeadmin` | always run migrations with `DATABASE_URL` user = `mikeadmin` so default privileges apply |
| Port 5432 / 4000 in use | something else listening | edit the host-side ports in `docker-compose.dev.yml` |

## Files

- `docker-compose.dev.yml` — stack definition (postgres, postgrest, azurite).
- `scripts/local-stack/00-init-roles.sql` — Postgres roles + default privileges.
- `scripts/local-stack/forge-jwt.mjs` — HS256 JWT minter (stdlib only).
- `backend/src/lib/supabase.ts` — fetch wrapper that strips the
  `/rest/v1` prefix supabase-js prepends, so the unmodified client
  can talk directly to PostgREST without a reverse proxy.
- `backend/src/lib/auth/providers/local.ts` — backend's HS256 verifier.
- `backend/migrations/0000_initial.sql` — the schema (shared with Azure).
