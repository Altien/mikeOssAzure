# Issue 021 — Backend PostgREST Client Boundary

## Goal

Prepare backend persistence for eventual Supabase-js removal by isolating the current PostgREST access pattern behind a local data-client boundary.

This issue does not remove `@supabase/supabase-js`.

## Context

The backend currently uses `@supabase/supabase-js` as a PostgREST client. That is useful but creates a naming/dependency mismatch for Azure/local mode. Direct removal would create a large fork from upstream because many backend modules use `.from(...).select(...)`, `.insert(...)`, `.update(...)`, and related patterns.

The upstream-compatible path is to isolate first, then decide later whether to keep Supabase-js as an implementation detail or replace it.

## What to build

### Data-client boundary

- Keep a single exported backend function for creating the app data client.
- Ensure all backend routes/libs import that local function instead of importing `@supabase/supabase-js` directly.
- Keep the returned interface compatible with current call sites where practical.
- Preserve existing behavior for local, Supabase, and Entra provider modes.

### Naming cleanup

- Prefer neutral names in new code, such as `createDataClient()` or `createPostgrestClient()`.
- Avoid broad renames of existing files unless they materially reduce future conflict.

### Future replacement notes

Document what would be needed to replace the implementation with:

- minimal `fetch`-based PostgREST client
- direct `pg`
- another data access layer

## Acceptance criteria

- [ ] No backend route imports `@supabase/supabase-js` directly.
- [ ] Existing call sites continue to work through the local data-client boundary.
- [ ] Local mode still talks to Caddy/PostgREST.
- [ ] Entra mode still supports managed identity token flow for PostgREST.
- [ ] `npm run build` passes in `backend/`.
- [ ] No package removal in this issue.

## Out of scope

- Removing `@supabase/supabase-js`.
- Rewriting queries.
- Replacing PostgREST.
- Moving persistence to direct `pg`.

## Dependencies

- `018-frontend-api-token-boundary.md`
- `020-azure-blob-storage-first.md`

