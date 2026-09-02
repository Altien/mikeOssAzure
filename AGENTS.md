# Agent Guidance

## Upstream Compatibility

This project is based on an upstream open-source repository. Prefer the smallest practical changes that achieve the local/Azure migration goals so future upstream changes remain easy to merge.

- Keep changes narrowly scoped to the migration or local-validation need being addressed.
- Avoid broad rewrites, stylistic churn, file moves, or dependency swaps unless they remove a concrete blocker.
- Prefer adapter layers, environment switches, and thin local overrides over changing shared application logic.
- When removing Supabase, AWS, or other upstream dependencies, do it incrementally and preserve upstream-shaped interfaces where practical.
- Document intentional divergence from upstream so future merges can evaluate conflicts quickly.

## Environment Variables and Secrets

### `.env` files must never contain real secrets in committed form

- The only `.env*` files tracked in git are `*.example` files with placeholder
  values, used as templates for developers.
- `.gitignore` excludes `.env`, `.env.*` and explicitly whitelists only
  `*.example` files. Do not add other whitelist exceptions.
- Real values — including `NEXT_PUBLIC_*` values that are not technically
  "secret" but identify our deployment (tenant GUIDs, app-registration GUIDs,
  deployed FQDNs) — belong in CI/Bicep parameter stores, Key Vault, or
  build-time injection, never in the repo.

### Don't commit `.env.production`

`.gitignore` rejects every `.env` and `.env.*` except `*.example` files.
There is no whitelist exception. If you find yourself wanting to add one,
stop — the rule exists because committing real values ties the source repo
to a specific deployment, and `NEXT_PUBLIC_*` values count as "real values"
even when they are not strictly secret (they identify a tenant).

### Runtime config, not build-time baking

The previous design baked customer-specific values (`NEXT_PUBLIC_ENTRA_*`,
`NEXT_PUBLIC_AUTH_PROVIDER`, `NEXT_PUBLIC_REDIRECT_URI`) into the JS bundle
at build time. That made the image per-tenant. Issues 030–032 retired that
pattern; the bundle is now tenant-portable.

How runtime config works now:

- `GET /config` on the backend returns `{ authProvider, entra: {…} }` from
  server env / Key Vault. Unauthenticated, cacheable.
- `frontend/src/contexts/ConfigContext.tsx` fetches `/config` once on app
  load and exposes the values via `useConfig()`.
- The same React hook also caches `authProvider` in `localStorage` under
  `mike.config.authProvider` so module-level helpers
  (`getBrowserAccessToken`, `getCachedAuthProvider`) can answer "what mode
  are we in?" without a React context.
- Sign-out goes through `GET /auth/logout` so the backend, not the
  browser, constructs the Microsoft logout URL.

Rules to keep this honest:

- **Don't reintroduce `NEXT_PUBLIC_ENTRA_*` or `NEXT_PUBLIC_AUTH_PROVIDER`.**
  If you need a new value in the browser at runtime, add it to the
  `/config` response and the `RuntimeConfig` type in `ConfigContext.tsx`,
  and read it via `useConfig()`.
- **The only `NEXT_PUBLIC_*` that survives is `NEXT_PUBLIC_API_BASE_URL`.**
  It is build-time-needed because the bundle has to know where to fetch
  `/config` from before the runtime config has loaded. It is not
  customer-specific (defaults to empty / same-origin); pass it as a
  Docker `--build-arg` for split-origin deployments.
- **Supabase env vars** (`NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`) are needed only when the
  deployment runs in supabase mode. They are not committed; in non-supabase
  modes the lazy `getSupabaseClient()` factory throws if anything reaches
  for them.
- **Naming convention for any new runtime config.** Server var name is
  `FOO`; runtime-config field is `foo` in `RuntimeConfig`. No
  `NEXT_PUBLIC_FOO` companion.

## Backend startup and tests

`backend/src/index.ts` must load `dotenv/config` and `./telemetry` before
instrumented modules. Application Insights patches modules at load time, so
moving Express, HTTP, or database imports above telemetry silently disables
automatic instrumentation.

Express app construction lives in `backend/src/app.ts` as the side-effect-free
`buildApp()` function. Keep process guards, secret warm-up, and `listen()` in
`index.ts`; backend route tests mount `buildApp()` through supertest.

Both packages use Vitest:

- `pnpm test` runs the suite once.
- `pnpm test:watch` runs in watch mode.
- `pnpm test:coverage` collects coverage.

Frontend tests use Testing Library and MSW. Components requiring runtime
configuration or authentication should use `renderWithProviders` from
`frontend/src/test/render.tsx`.

The Express app itself is constructed in `backend/src/app.ts`
(`buildApp()`, side-effect free); `index.ts` holds only entrypoint
concerns (dotenv → telemetry → process guards → secret warm-up →
listen). Route tests mount `buildApp()` via supertest — don't move app
construction back into `index.ts`.

## Tests

Both packages run vitest: `pnpm test` (once), `pnpm test:watch`,
`pnpm test:coverage` — in `backend/` (node env + supertest) and
`frontend/` (jsdom + Testing Library + MSW; harness in
`frontend/src/test/`, use `renderWithProviders` from `render.tsx` for
components that need Config/Auth context). Run the affected package's
suite before committing backend/ or frontend/ source changes.

### Pre-commit checks the agent should run

Before committing changes that touch `.env*` files or env-var lookups:

1. `git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$'` — must
   return nothing. If it does, you are about to commit a `.env` file that
   isn't a template.
2. `grep -rE "process\.env\.NEXT_PUBLIC_[A-Z_]+" frontend/src` — every match
   should be one of: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. Anything else means
   someone tried to reintroduce build-time baking — push back to runtime
   config in `ConfigContext`.
3. No tenant-specific identifiers (Entra GUIDs, deployment FQDNs,
   resource names) should appear in any tracked `.env*.example` or any
   committed source file. Use placeholders.
