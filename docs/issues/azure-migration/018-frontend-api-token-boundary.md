# Issue 018 — Frontend API Token Boundary

## Goal

Centralize frontend token retrieval and backend API calls so components no longer know whether the active token came from Supabase, Entra, or local auth.

This reduces fork size and prepares for later dependency removal without scattering conditional logic through the UI.

## Context

Several frontend components call `supabase.auth.getSession()` directly before calling the Node backend. That makes local auth harder and keeps Supabase wired into unrelated UI components.

The right boundary is:

- `AuthContext` owns sign-in/sign-out/user state.
- A shared token helper owns browser token retrieval.
- Shared API helpers attach `Authorization: Bearer <token>`.
- Components call domain helpers or the shared fetch helper.

## What to build

### Token helper

Add or finalize a browser token helper that:

- returns local token when `NEXT_PUBLIC_AUTH_PROVIDER=local`
- returns Entra token when `NEXT_PUBLIC_AUTH_PROVIDER=entra`
- returns Supabase session token when `NEXT_PUBLIC_AUTH_PROVIDER=supabase`
- has no side effects beyond reading current browser/session state

### API helper

Update frontend backend-call helpers to use the token helper.

### Component cleanup

Remove direct `supabase.auth.getSession()` calls from components and hooks that are only calling the Node backend.

Known areas to check:

- assistant message actions
- edit accept/reject actions
- document panel downloads
- DOCX byte fetching
- document version hooks
- single-document fetch hooks
- `mikeApi`

## Acceptance criteria

- [x] No component/hook fetches backend routes by first calling `supabase.auth.getSession()` directly.
- [x] Backend-bound requests attach the active auth token through one shared helper.
- [x] Local auth, Entra auth, and Supabase auth modes remain selectable through env.
- [x] `npm run build` passes in `frontend/`.
- [x] No backend changes except where required for issue 017.

## Current status — 2026-05-05

Implemented on branch `codex/local-first-upstream-planning`.

Known remaining Supabase auth calls are inside provider-owned auth modules and pages:

- `frontend/src/contexts/AuthContext.tsx` for Supabase mode session/sign-out handling.
- `frontend/src/lib/auth-token.ts` for Supabase mode token retrieval.
- `frontend/src/app/login/page.tsx` for Supabase password login.
- `frontend/src/lib/auth.ts` for legacy Supabase auth helper surface.

Those are not backend-bound component call sites. A follow-up should decide whether to keep the Supabase provider as an upstream compatibility adapter or remove it after the rest of the browser data/auth imports are isolated.

## Out of scope

- Removing `frontend/src/lib/supabase.ts`.
- Removing Supabase packages.
- Replacing all direct Supabase data access if any remains outside backend-bound API calls.

## Dependencies

- `017-local-first-auth-boundary.md`
