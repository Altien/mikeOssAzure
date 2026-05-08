# Issue 032 — Retire `frontend/.env.production`

> **Status: shipped.** `frontend/.env.production` deleted from git.
> `.gitignore` whitelist removed. `Dockerfile` declares
> `ARG NEXT_PUBLIC_API_BASE_URL` at the frontend-builder stage so the
> deploy pipeline passes the value as a build-arg. `frontend/.env.local.example`
> rewritten to document the new (much smaller) shape.

## Goal

Stop committing `frontend/.env.production` to the repository. Remove
the `.gitignore` whitelist that keeps it tracked. After this lands,
no `.env*` file in the tree contains values specific to a deployment
or a tenant.

This is the final step that lets the same Docker image run against
any Azure tenant — the one prerequisite that makes the Tier B AGPL
publication a runnable artefact instead of a per-customer template.

## Context

`frontend/.env.production` is committed because Next.js bakes
`NEXT_PUBLIC_*` values into the bundle at build time and the
Container App Docker build picks them up from this file. Today the
file holds:

```
NEXT_PUBLIC_AUTH_PROVIDER=entra            # (issue 030 removes this read)
NEXT_PUBLIC_API_BASE_URL=                  # empty for same-origin; build-time-needed
NEXT_PUBLIC_SUPABASE_URL=...               # (issue 031 removes this read)
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...  # (issue 031 removes this read)
NEXT_PUBLIC_ENTRA_CLIENT_ID=<real GUID>    # (issue 030 removes this read)
NEXT_PUBLIC_ENTRA_TENANT_ID=<real GUID>    # (issue 030 removes this read)
NEXT_PUBLIC_ENTRA_BACKEND_SCOPE=...        # never read, dead
NEXT_PUBLIC_REDIRECT_URI=<real FQDN>       # (issue 030 removes this read)
```

After issues 030 and 031, **every value in this file is either dead
or already empty**, except `NEXT_PUBLIC_API_BASE_URL`. That single
remaining value is a deployment-shape choice (same-origin vs split-
origin), not a tenant identifier. It belongs in the build pipeline,
not in the source repo.

## Prerequisites

- Issue 030 (runtime config endpoint) is merged. None of the
  `NEXT_PUBLIC_ENTRA_*`, `NEXT_PUBLIC_AUTH_PROVIDER`, or
  `NEXT_PUBLIC_REDIRECT_URI` env vars are read by the frontend
  anymore.
- Issue 031 (supabase placeholder removal) is merged. The supabase
  client is constructed lazily and only when `authProvider ===
  "supabase"`.

If either is incomplete, **stop**. Removing `.env.production` before
those refactors land would break the entra-mode build.

## What to build

### Repository

#### Delete the file

```sh
git rm frontend/.env.production
```

#### Update `.gitignore`

Remove the whitelist line:

```diff
-# Frontend production env: NEXT_PUBLIC_ vars only (public by design,
-# inlined into the JS bundle). Picked up by `next build` and shipped
-# to ACR via the Docker build context. Server-side secrets never
-# belong here — those live in backend/.env / Key Vault.
-!frontend/.env.production
```

After this, the existing `.env.*` rule keeps every variant out by
default. Future contributors cannot accidentally re-commit it.

#### Update `frontend/.env.local.example`

Document the post-030/031 shape clearly:

```
# Backend API base URL.
# Leave blank for the bundled deploy (frontend served from same
# origin as backend). Set to an absolute URL when running the
# frontend dev server (npm run dev) against a separate backend.
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001

# Supabase mode only — leave unset for local / entra modes.
# NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
# NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-anon-key
```

### Build pipeline (Tier C — internal repo only)

The internal `deploy.ps1` and `.github/workflows/deploy.yml` (when
restored) need to set `NEXT_PUBLIC_API_BASE_URL` for the Docker
build. Two options:

#### Option 1: Docker build arg (recommended)

In `Dockerfile`:

```diff
 FROM node:22-slim AS frontend-builder
 WORKDIR /app

+ARG NEXT_PUBLIC_API_BASE_URL=
+ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
+
 COPY frontend/package.json frontend/package-lock.json ./
 RUN npm ci --ignore-scripts --legacy-peer-deps

 COPY frontend/. ./
 RUN npm run build
```

`deploy.ps1` and the GitHub Actions workflow then pass:

```sh
az acr build --build-arg NEXT_PUBLIC_API_BASE_URL= …
```

For the bundled deploy the value is empty (same-origin). For any
future split-origin deployment we change the build arg.

#### Option 2: Generate `.env.production` at build time

The deploy pipeline writes `frontend/.env.production` into the build
context just before `az acr build`, then deletes it after. The file
exists transiently on the build machine, never reaches the
repository.

Option 1 is cleaner — explicit, single value, no transient files —
and is the recommendation. If any future build needs more than one
build-time value, revisit.

### Local dev (no change)

`frontend/.env.local` for `npm run dev` still works as today (each
developer's local file, gitignored). The only `.env.local` change
is the example file's documentation update above.

## Acceptance criteria

- [ ] `git ls-files | grep -E '(^|/)\.env'` returns only `*.example`
      files. No `frontend/.env.production`. No tracked `.env`.
- [ ] `.gitignore` no longer whitelists any non-example `.env` file.
- [ ] `npm run build --prefix frontend` succeeds in a clean checkout
      with no `frontend/.env.production` and no `NEXT_PUBLIC_ENTRA_*`
      / `NEXT_PUBLIC_AUTH_PROVIDER` / `NEXT_PUBLIC_SUPABASE_*` env
      vars set in the shell.
- [ ] The Docker build (`docker build -f Dockerfile .`) succeeds with
      `--build-arg NEXT_PUBLIC_API_BASE_URL=`.
- [ ] The bundled-deploy image still serves the frontend correctly
      against a real backend in entra mode — login redirects through
      Microsoft, app loads, sign-out works.
- [ ] The pre-publication sanitization regex in
      `docs/migration/05-config-extraction.md` returns zero matches
      against the head of this branch.
- [ ] `AGENTS.md` "Don't commit `.env.production`" rule is no longer
      describing a known violation — it now describes a maintained
      invariant. (Update the sentence accordingly when this lands.)

## Out of scope

- Backend `.env` handling. Backend secrets are already routed through
  Key Vault / Container App env refs.
- Splitting the frontend and backend into separate Container Apps
  (would change `NEXT_PUBLIC_API_BASE_URL` from "empty" to "absolute
  URL" but is independent of this issue's plumbing).
- Marketplace packaging. The marketplace listing's Bicep will set the
  build arg for whatever shape the customer's deployment takes.

## Related

- Issue 030 — required prerequisite (runtime config endpoint).
- Issue 031 — required prerequisite (supabase placeholder removal).
- `docs/migration/05-config-extraction.md` — describes the
  sanitization regex this issue closes.
- `docs/migration/03-fork-publication.md` — once this issue is in,
  the public-fork publication runbook can drop its "delete
  `frontend/.env.production`" step (it is no longer in the tree to
  delete).
- `AGENTS.md` "Environment Variables and Secrets" section — this
  issue is the implementation of the rule that section asserts.
