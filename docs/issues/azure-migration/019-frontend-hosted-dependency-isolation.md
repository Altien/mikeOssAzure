# Issue 019 — Frontend Hosted Dependency Isolation

## Goal

Make the compiled frontend client work for local/Azure mode without requiring browser-side Supabase or AWS/S3 configuration.

This issue isolates hosted-service dependencies first. Remove packages only after imports are behind boundaries or proven unused.

## Context

The frontend should talk to the Node backend for application data and document operations. Browser code should not require Supabase PostgREST, Supabase Auth, R2, or AWS S3 configuration when running in local/Azure mode.

However, this project tracks an upstream open-source app, so removals should be incremental and low-conflict.

## What to build

### Supabase client isolation

- Ensure local mode can build without real `NEXT_PUBLIC_SUPABASE_URL`.
- Keep `frontend/src/lib/supabase.ts` constructible for upstream compatibility.
- Avoid importing the Supabase client in files that do not need Supabase mode.

### AWS/S3 isolation

- Identify browser-side imports of `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
- Move storage operations behind Node backend routes where possible.
- Avoid bundling AWS SDK into the browser for local/Azure mode.
- Keep R2/AWS fallback only behind a compatibility boundary if still needed.

### Dependency review

After isolation:

- list which Supabase/AWS frontend dependencies are still used
- remove only packages with zero imports or packages that are fully replaced by a provider boundary

## Acceptance criteria

- [ ] `NEXT_PUBLIC_AUTH_PROVIDER=local npm run build` passes in `frontend/`.
- [ ] The compiled frontend does not require hosted Supabase env vars in local mode.
- [ ] The compiled frontend does not require AWS/S3 env vars in local mode.
- [ ] Any remaining Supabase/AWS imports are documented with why they remain.
- [ ] Package removals, if any, are small and justified by zero remaining use.

## Out of scope

- Replacing backend storage implementation.
- Replacing backend persistence implementation.
- Removing upstream compatibility shims prematurely.

## Dependencies

- `018-frontend-api-token-boundary.md`

