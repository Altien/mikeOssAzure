# Issue 017 — Local-First Auth Boundary

## Goal

Make the frontend and backend work locally without hosted Supabase Auth or Entra, while preserving the existing upstream-shaped auth boundary (`AuthContext`, `useAuth()`, bearer tokens).

This is a refactor-before-remove issue. Do not delete Supabase auth dependencies in this slice.

## Context

The app needs a reliable local development path:

- frontend served locally on `localhost:3000`
- Node backend on `localhost:3001`
- Docker data plane for Postgres/PostgREST/Caddy/Azurite
- local HS256 JWT auth for development

Azure Container Apps remains the deploy target, not the inner-loop development environment.

## What to build

### Backend

Add a local-only auth endpoint:

- `POST /auth/local-login`
- Enabled only when `AUTH_PROVIDER=local`
- Requires `JWT_SECRET`
- Returns `{ token, user }`
- Token must be HS256 and compatible with `backend/src/lib/auth/providers/local.ts`
- User ID should be stable for a given email so local data remains consistent between logins

### Frontend

Extend the existing auth provider boundary:

- Add `NEXT_PUBLIC_AUTH_PROVIDER=local`
- Keep `supabase` and `entra` behavior intact
- Keep the public `AuthContext` shape stable where practical
- Store local token/user in browser local storage
- `getAccessToken()` returns the local token in local mode
- Login page supports local login without calling Supabase Auth

## Acceptance criteria

- [x] `AUTH_PROVIDER=local` backend starts without Supabase Auth configuration.
- [x] `POST /auth/local-login` returns a valid bearer token.
- [x] Local token works against authenticated backend routes.
- [x] Frontend can log in locally and navigate to authenticated pages.
- [x] Supabase and Entra modes still compile.
- [x] No broad UI rewrites.
- [x] `npm run build` passes in `backend/`.
- [x] `npm run build` passes in `frontend/`.

## Current status — 2026-05-05

Implemented and validated as part of branch `codex/local-first-upstream-planning`.

This issue also grew a small Entra slice: the frontend can now redirect to the backend provider-selection endpoint and complete Microsoft login locally. The detailed Entra portal setup lives in `docs/runbook-entra-local-auth.md`.

## Out of scope

- Removing Supabase packages.
- Replacing backend `@supabase/supabase-js`.
- Replacing PostgREST.
- Azure Entra login changes.

## Dependencies

- `008.0-local-auth-provider.md`
- `docs/local-first-upstream-strategy.md`
