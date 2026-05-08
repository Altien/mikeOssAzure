# Local-First, Upstream-Compatible Migration Strategy

Date: 2026-05-05

## Goal

Make this fork developable and validatable locally while keeping the codebase close enough to the upstream open-source project that future upstream changes can still be merged with limited conflict.

Azure Container Apps is the deployment target. It should not be the primary place where we discover ordinary development breakage.

## Guiding Principles

- Prefer local validation before Azure validation.
- Keep upstream-shaped application code where practical.
- Make the smallest useful change at each boundary.
- Refactor before removing dependencies that have many call sites.
- Remove Supabase, AWS, R2, or other upstream dependencies only after their usage is isolated behind a clear local interface.
- Prefer adapters and provider switches over broad rewrites.
- Document intentional divergence from upstream.

These principles are also recorded in the root `AGENTS.md`.

## Current Direction

The local development target should be:

- Node backend on `localhost:3001`.
- Compiled or dev-served JavaScript frontend on `localhost:3000`.
- Docker data plane for Postgres, PostgREST, and Azurite.
- Local auth provider for development, using HS256 JWTs signed by `JWT_SECRET`.
- Entra auth mode for validating real Microsoft sign-in locally.
- Azure Blob-compatible storage locally via Azurite.

This gives us a fast inner loop while still exercising the same major boundaries as Azure:

- frontend to Node API
- Node API auth middleware
- Node API to PostgREST/Postgres
- Node API to blob storage

## Refactor Before Remove

### Frontend Auth

Refactor first.

Keep the existing `AuthContext` and `useAuth()` surface so most UI code does not care whether auth is Supabase, Entra, or local. Add provider-specific behavior behind that context:

- `supabase`: upstream/default behavior
- `entra`: Azure tenant behavior
- `local`: local development behavior

This lets us support local login without rewriting every page or component.

For Entra validation, use the MatterAI-style backend provider-selection flow documented in `docs/auth-provider-selection-flow.md`: the frontend redirects to the backend auth selection endpoint, and the backend owns the Microsoft authorize URL and OpenID callback. Keep the browser-facing result as the same bearer token contract until we deliberately choose to move to backend sessions.

### Frontend Backend Calls

Refactor first.

Move backend calls through shared helpers that attach the active browser token. Components should not repeatedly call `supabase.auth.getSession()` directly. That keeps local auth, Entra auth, and any remaining Supabase auth behavior behind one boundary.

### Frontend Supabase/AWS Packages

Do not remove immediately.

First isolate imports and call sites. Once the compiled frontend no longer needs browser-side Supabase or AWS storage paths, remove those packages from `frontend/package.json` in a small follow-up change.

### Backend Storage

Refactor before removing R2/AWS.

Keep a storage-provider boundary and make Azure Blob/Azurite the preferred provider. Remove R2/AWS only after the backend can run all document flows locally and in Azure without falling back to those paths.

### Backend Persistence

Do not remove Supabase client yet.

The backend currently uses `@supabase/supabase-js` as a PostgREST client. Removing it directly would create a large fork. First isolate persistence behind a local module or adapter. After that, we can decide whether to keep Supabase-js as an implementation detail, replace it with a minimal PostgREST client, or move to direct `pg`.

## Local Validation Gate

Before pushing changes toward Azure, validate locally:

1. Docker data plane is up.
2. Database migrations have run.
3. Azurite has the required blob containers.
4. Backend builds.
5. Frontend builds.
6. Backend `/health` responds.
7. Local login can produce a token.
8. Authenticated frontend flows can call the Node backend.
9. Core document/project flows work without hosted Supabase or AWS services.

Azure CI/CD should be the deployment ratchet after local validation, not the first meaningful test.

## Current Status — 2026-05-05

Completed in the local-first mini-sprint:

- Backend and frontend compile locally.
- Docker data-plane check script exists: `scripts/dev-infra-check.ps1`.
- Local auth mode exists for fast development: `POST /auth/local-login`.
- Frontend token retrieval is centralized enough for local and Entra bearer tokens.
- Backend Entra JWT validation exists.
- Backend-owned Microsoft login flow exists and was validated through successful sign-in.
- Entra setup is documented in `docs/runbook-entra-local-auth.md`.

Still to validate or refactor:

- Exercise authenticated project/document workflows after Entra login.
- Decide whether local Entra data access should use local service-role PostgREST auth, direct Postgres, or an Azure-compatible token path.
- Isolate remaining frontend Supabase imports so Entra/local mode no longer needs Supabase browser env placeholders.
- Isolate backend `supabase-js` usage behind a narrower PostgREST/data-client boundary before removing it.

## What Counts As Intentional Divergence

Document any of these when they happen:

- replacing upstream auth behavior
- replacing upstream storage behavior
- removing a dependency from `package.json`
- changing API contracts between frontend and backend
- replacing Supabase-js or AWS SDK call sites
- moving data access away from PostgREST

The preferred shape for divergence is a small adapter or provider, not scattered conditional logic across the app.

## Near-Term Work Plan

1. Merge this local-first branch to `main`.
2. Revalidate local Entra login from clean `main`.
3. Exercise authenticated frontend flows against the Node backend.
4. Keep Supabase/AWS packages present until imports are isolated.
5. Convert storage to Azure Blob/Azurite-first through the existing provider boundary.
6. Only then remove unused frontend/backend dependencies in focused commits.
