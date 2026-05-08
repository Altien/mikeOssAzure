# Issue 031 — Supabase Placeholder Removal

> **Status: shipped.** `frontend/src/lib/supabase.ts` exports
> `getSupabaseClient()` lazily. `lib/supabase-server.ts` and `lib/auth.ts`
> updated to throw clear errors / return null instead of asserting on
> placeholder values. Login page calls `getSupabaseClient()` only inside
> the supabase branch. `AuthContext` calls it only inside the supabase
> arm of the provider switch.

## Goal

Stop carrying `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` placeholder values in
`frontend/.env.production`. Make the supabase client construct lazily
and only when supabase mode is actually active, so non-supabase
deployments need none of these env vars to build or run.

## Context

Today `frontend/src/lib/supabase.ts` constructs the supabase client at
module load:

```ts
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || (isLocalAuth ? "http://localhost:8000" : "");
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || (isLocalAuth ? "local-dev-key" : "");
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

`frontend/src/lib/auth.ts` uses non-null assertions on the same env
vars, which would explode at module load if they were genuinely
missing:

```ts
return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,
);
```

In Entra mode the client is **never called**. The only reason these
values exist in `frontend/.env.production` is to keep the supabase-js
constructor from throwing during the static-export build:

```
# frontend/.env.production
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.invalid
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=placeholder
```

This is an "appease the constructor" workaround. It surfaces in
several bad ways:

- `frontend/.env.production` carries values that mean nothing —
  reviewers have to remember "those aren't real."
- A future bug that accidentally calls the supabase client in entra
  mode would fire HTTP requests at `placeholder.invalid` and fail
  in a confusing way instead of failing fast.
- It blocks the issue 032 cleanup: even after issue 030 lands and
  every `NEXT_PUBLIC_ENTRA_*` is gone, the supabase placeholders
  still force `.env.production` to exist.

## What to build

### `frontend/src/lib/supabase.ts`

Convert from a module-level export to a lazy factory:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
    if (_client) return _client;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
    if (!url || !key) {
        throw new Error(
            "Supabase client requested but NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY are not set. " +
                "This deployment is in non-supabase mode — check authProvider in /api/config.",
        );
    }
    _client = createClient(url, key);
    return _client;
}
```

Update every existing `import { supabase } from "@/lib/supabase"` to
call `getSupabaseClient()` at the call site. Search:

```sh
grep -rn 'from "@/lib/supabase"' frontend/src
```

For each call site:

- If the call is inside an `if (authProvider === "supabase")` branch
  (or equivalent), call `getSupabaseClient()` directly.
- If the call is in a code path that runs in **all** modes (e.g. an
  effect that subscribes to auth-state changes), gate it on
  `useConfig().authProvider === "supabase"` (post-issue-030) before
  invoking the helper.

### `frontend/src/lib/auth.ts`

Same pattern. Replace the non-null-asserted module-level call with a
function:

```ts
export function getServerSupabase(): SupabaseClient {
    return getSupabaseClient();
}
```

Or delete `auth.ts` if it's only re-exporting the module-level client
— it doesn't add anything once the export is a function.

### `frontend/src/lib/supabase-server.ts`

Mirrors the same change. Convert any module-level `createClient`
calls to lazy factory functions.

### Frontend env-var deletes

After this issue:

- Delete `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` from
  `frontend/.env.production` (issue 032 removes the file entirely).
- Keep them in `frontend/.env.local.example` under a clearly-marked
  "supabase mode only" section.

### Backend (no changes)

The backend's `@supabase/supabase-js` usage (`createServerSupabase`)
is independent — it's a server-side PostgREST client and is gated
appropriately on `AUTH_PROVIDER`. No changes here.

## Acceptance criteria

- [ ] `frontend/src/lib/supabase.ts` exports a `getSupabaseClient()`
      function, not a module-level `supabase` constant.
- [ ] No call site imports `supabase` as a module-level value;
      every consumer calls `getSupabaseClient()`.
- [ ] In a clean checkout with neither `NEXT_PUBLIC_SUPABASE_URL` nor
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` set,
      `npm run build --prefix frontend` succeeds.
- [ ] In a build of the entra-mode bundle (no supabase env vars set),
      end-to-end usage of the deployed app does not throw.
- [ ] In supabase mode, all upstream supabase auth flows still work
      (regression check on the upstream-shaped behaviour).
- [ ] Calling `getSupabaseClient()` when env vars are unset throws a
      clear error mentioning `/api/config` and the current
      `authProvider`.

## Out of scope

- Removing `@supabase/supabase-js` from `package.json`. Long-term
  goal but a separate issue (the backend still uses it as a PostgREST
  client).
- Changing the supabase auth flow itself.
- The bigger frontend hosted-dependency-isolation work — see
  `019-frontend-hosted-dependency-isolation.md`.

## Related

- Issue 019 — frontend hosted-dependency isolation. This issue is the
  small concrete step; 019 is the broader cleanup.
- Issue 030 — runtime config endpoint. Independent but expected to
  land around the same time.
- Issue 032 — retire `frontend/.env.production`. **Depends** on this
  issue plus 030.
- `docs/migration/05-config-extraction.md` — explains why the
  placeholder values are tier-C-adjacent: they aren't secrets, but
  their presence in the repo is a smell.
