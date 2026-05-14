# Testing Regime

Living document. Describes **how** unit tests are organised in
`backend/` and `frontend/`, **what** is currently covered, and **what
is intentionally out of scope** for the unit suite (vs. the future
integration suite).

The companion documents `backend-test-suite-prompt.md` and
`frontend-test-suite-prompt.md` are the *specifications* fed to an
agent to extend each suite. This file is the *operational tracker*:
what exists today, what's queued, and the conventions/patterns the
suites already follow so subsequent work stays consistent.

Backend material lives in §1–§8 and §10. Frontend material lives in
§11–§14. §9 is the cross-suite handoff. Both sides share §10
(change log).

---

## 1. Toolchain

| Concern | Tool | Why |
| --- | --- | --- |
| Runner | **Vitest 4** | TS-native, Jest-compatible API, fast (esbuild). |
| Coverage | `@vitest/coverage-v8` | Built-in, accurate branch counts. |
| Path aliases | `vite-tsconfig-paths` | Resolves the `@/*` alias from `tsconfig.json` with no extra config. |
| HTTP route tests | `supertest` | Mount the Express app without binding a port. Only used once `src/app.ts` is split out from `src/index.ts`. |

Config lives in `backend/vitest.config.ts`. Environment is `node`. Test
files are co-located with sources (`foo.ts` → `foo.test.ts`).

## 2. Running tests

```bash
cd backend
npm test                  # one-shot
npm run test:watch        # interactive
npm run test:coverage     # one-shot + v8 coverage (html, text, lcov)
```

A focused run looks like:

```bash
npx vitest run src/lib/access.test.ts
npx vitest run --coverage --coverage.include='src/middleware/auth.ts'
```

## 3. Conventions

The full set is in `backend-test-suite-prompt.md` §3 and §7. Key
expectations the suite already enforces:

- **Explicit imports** of `describe`/`it`/`expect`/`vi` — `globals: false`
  in the Vitest config so tests are greppable.
- **Arrange / Act / Assert** with blank-line separation in each `it`
  block.
- **One behaviour per test.** Multiple `expect` calls are fine when they
  describe the same outcome (e.g. status + body shape + side-effect call).
- **No real network, DB, FS, or subprocess.** All collaborators are
  injected or mocked.
- **Deterministic.** No `Date.now()`/`Math.random()`/`setTimeout` without
  fake timers.
- **`clearMocks: true, restoreMocks: true`** in the Vitest config — every
  test starts with fresh mock state.

## 4. Patterns

### 4.1 Fake supabase-style DB

`src/lib/access.test.ts` defines a small `makeFakeDb` helper that returns a
chainable builder satisfying the supabase-js fluent API
(`from().select().eq().single()`, `from().select().in()`,
`.contains().neq()`). It's queued per-table so a function that hits the
same table multiple times in parallel can return different rows for each
call. Reach for this pattern (or extract it to `src/test/helpers/db.ts`
when a third module needs it) before mocking the supabase client module
itself — injected fakes are simpler to type and faster.

### 4.2 Module mocks via `vi.mock`

`src/middleware/auth.test.ts` mocks the three auth provider modules,
`tenantAccess`, and `upsertUserProfile` at the top of the file. The mock
paths must match the import specifiers used by the SUT *exactly* — that
means including the `.js` extension where the source uses one. Vite's
resolver maps `.js` to the corresponding `.ts` automatically.

### 4.3 Faking `req`/`res`/`next`

```ts
function makeReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as unknown as Request;
}
function makeRes(): FakeRes {
  const res = { locals: {}, statusCode: 200 } as FakeRes;
  res.status = vi.fn(c => (res.statusCode = c, res)) as FakeRes["status"];
  res.json   = vi.fn(b => (res.body = b, res))       as FakeRes["json"];
  return res;
}
```

This pattern is in `src/middleware/auth.test.ts`. Promote to
`src/test/helpers/http.ts` once a second middleware test uses it.

### 4.4 Env-var isolation

Tests that depend on `process.env.AUTH_PROVIDER` (and similar) snapshot
the original value in `beforeEach`, mutate freely, and restore in
`afterEach`. Never use `vi.stubEnv` for variables the SUT reads via
`process.env.FOO ?? "default"` — `stubEnv` deletes the var on restore,
which can interfere with downstream tests in the same file.

## 5. What we test — and don't

### In scope for the unit suite

| Area | Status |
| --- | --- |
| `src/lib/**` pure helpers, validators, token shapers, access logic | In progress |
| `src/middleware/**` — header/auth/tenant/role gating | In progress |
| `src/lib/auth/providers/**` token validation | Pending |

### Out of scope (belongs to a future integration or e2e suite)

- Real Postgres connections (mocked via fake builders or `pg` `Pool`).
- Real Anthropic / OpenAI / Google GenAI / Resend / S3 / Azure traffic.
- LibreOffice subprocess invocation.
- Browser flows.
- Migration SQL semantics — the *runner* is unit-tested, the *SQL* is not.

## 6. Coverage manifest

Generated by hand from `npm run test:coverage` after each iteration.
Numbers are line / branch / function percentages.

| File | Tests | Stmts | Branch | Funcs | Notes |
| --- | --- | --- | --- | --- | --- |
| `src/lib/access.ts` | 22 | 95 | 88 | 100 | Lines 119, 204-209 are defensive null/throw branches. |
| `src/lib/auth/roles.ts` | 8 | 100 | 100 | 100 | — |
| `src/lib/auth/providers/supabase.ts` | 8 | 100 | 100 | 100 | — |
| `src/lib/auth/providers/local.ts` | 19 | 100 | 100 | 100 | Real HMAC verification — tests cover alg-confusion, tampered payloads, wrong-length signatures. |
| `src/lib/auth/providers/entra.ts` | 33 | 100 | 97 | 100 | Real RS256 signing with a generated key pair + stubbed JWKS — exercises full verifier, JWKS cache, both token versions. |
| `src/lib/downloadTokens.ts` | 21 | 100 | 100 | 100 | Real HMAC round-trips; covers payload tampering, sig truncation, secret-fallback chain, prod-mode hard fail. |
| `src/lib/userApiKeys.ts` | 28 | 99 | 91 | 100 | Real AES-256-GCM encrypt/decrypt; covers ciphertext-never-in-DB invariant, IV uniqueness, GCM tampering rejection, azure_openai blob serialisation, legacy column fallback. |
| `src/lib/userSettings.ts` | 26 | 100 | 100 | 100 | Pins the IdP-display-name back-fill rule (user's typed name wins), the gemini→openai→claude→aoai fast-model chain, and idempotency when nothing changed. |
| `src/lib/config.ts` | 17 | 100 | 100 | 100 | Env-var override (uppercase + hyphen→underscore), per-secret cache, TTL respected, custom TTL via env, KV writes invalidate only that key. |
| `src/routes/auth.ts` | 37 | 98 | 87 | 100 | OAuth state HMAC + 10-min replay window, open-redirect guard on returnUrl, alg-confusion-style state tampering, every error→/login redirect path. |
| `src/routes/config.ts` | 13 | 100 | 100 | 100 | Allow-list on AUTH_PROVIDER (clamps unknown values to "supabase"), explicit secret-leak guard with placeholder secrets in env. |
| `src/routes/downloads.ts` | 13 | 100 | 100 | 100 | requireAuth wiring; refuses-to-leak-existence (404 on access deny rather than 403); MIME mapping per extension; deleted-blob handling. |
| `src/routes/user.ts` | 28 | 89 | 76 | 94 | **Pins a latent bug** in GET /profile: the credit-rolling block (lines 50–60) is unreachable today because normalizeCreditsResetDate rewrites past dates to future ones *before* the rolling check fires. A future refactor that fixes the rolling logic will break the "credits stay at 99" pin — that's the intended signal. The other uncovered branches are nullish-fallback variants on already-tested code paths. |
| `src/middleware/auth.ts` | 16 | 100 | 100 | 100 | — |
| `src/middleware/tenantAccess.ts` | 14 | 100 | 100 | 100 | — |
| `src/middleware/requireRole.ts` | 8 | 100 | 100 | 100 | — |

## 7. Queue

Ordered by **security risk × refactor frequency**. The expectation is
that each entry, once worked, lands with substantial behavioural tests
(not just happy-path smoke).

1. ~~`src/middleware/tenantAccess.ts`~~ — done. 14 tests pin down the
   entra-only gating, the manual-vs-auto onboarding fork, every
   tenant-status outcome, and the GROUP_NOT_WHITELISTED deny.
2. ~~`src/middleware/requireRole.ts`~~ — done. 8 tests, case-sensitive
   role check, defensive against missing principal/roles.
3. ~~`src/lib/auth/providers/supabase.ts`~~ — done. 8 tests covering
   config gaps, getUser mocking, principal shape, secret-leak guard.
4. ~~`src/lib/auth/providers/local.ts`~~ — done. 19 tests covering
   alg-confusion (RS256 in header, alg=none), tampered-payload
   detection, wrong-length sig, every claim-validation branch.
5. ~~`src/lib/auth/providers/entra.ts`~~ — done. 33 tests covering
   real RS256 signing with a generated key pair, every JWKS failure
   mode, the v1/v2 issuer fork, both audience shapes (`<guid>` and
   `api://<guid>`), the groups-overage warning, and the email/display
   name fallback chains.
6. ~~`src/lib/downloadTokens.ts`~~ — done. 21 tests covering HMAC
   round-trips, payload tampering (CWE-345), signature truncation,
   URL-safe encoding, the DOWNLOAD_SIGNING_SECRET / SUPABASE_SECRET_KEY
   / dev-fallback chain, and the production hard-fail.
7. ~~`src/lib/userApiKeys.ts`~~ — done. 28 tests, real AES-256-GCM.
   Pins down: plaintext never sent to DB, IVs are unique per call,
   GCM tampering is rejected (a corrupted auth tag silently drops the
   row), legacy column fallback fires only when no encrypted row
   exists, wrong-shape plaintexts throw for non-azure providers.
8. ~~`src/lib/userSettings.ts`~~ — done. 26 tests pin the
   gemini→openai→claude→aoai fast-model fallback chain, the
   AZURE_OPENAI_DEPLOYMENT env fallback, the
   user-display-name-beats-IdP back-fill rule, and idempotency when
   nothing changed.
9. ~~`src/lib/config.ts`~~ — done. 17 tests cover the env-override →
   cache → KV-fetch order, hyphen-to-underscore env-name mapping,
   per-secret cache scoping, `flushConfigCache()` rotation, `setConfig`
   invalidating only the affected key, and the configurable
   CONFIG_CACHE_TTL_SECONDS (including non-numeric/negative input).
10. `src/lib/builtinWorkflows.ts` — **deliberately not tested**. The
    file is a static array of three prompt strings with zero logic.
    Asserting "the array has 3 entries with these ids" would not catch
    a real refactoring failure — anyone editing the prompts would have
    to update the test in lockstep, making it a churn-multiplier with
    no defensive value. Test only if/when a registry-lookup function
    is added.

Routes (`src/routes/**`) are unblocked by the `src/app.ts` split
documented below.

## 7a. The `src/app.ts` split — production-code refactor

This is the **one** production-code change the test suite makes. It's
documented before the work so the diff has a recorded justification.

### Why

Today `src/index.ts` does three things in one module:

1. Imports the route files.
2. Builds an Express `app` with helmet / cors / rate limiters / parsers
   / routers / SPA fallback.
3. Calls `app.listen(PORT)`.

The third step is a side effect at module-load time. Any test that does
`import { app } from "@/index"` would bind `PORT=3001` for real, fight
parallel test workers for the socket, and leak a server past
`vitest run`. `supertest` mounts the app on its own ephemeral server
per request, so we don't *need* `listen()` for tests — we just need to
get `app` without it.

### What moves

- All construction (helmet, cors, limiters, parsers, route mounts, SPA
  fallback) moves into a new `src/app.ts` exporting
  `buildApp(): express.Express`.
- The rate-limiter setup, the `PUBLIC_DIR` / `FRONTEND_BUNDLED` checks,
  and the `findShell` helper move *inside* `buildApp` so each call
  reads the **current** `process.env` and filesystem state. This
  matters: tests mutate env vars between cases, so module-load-time
  reads would be brittle.
- `src/index.ts` shrinks to:

  ```ts
  import "dotenv/config";
  import { buildApp } from "./app";
  const PORT = process.env.PORT ?? 3001;
  buildApp().listen(PORT, () => console.log(...));
  ```

### What stays the same

- Mount paths, route ordering, middleware order, headers — every byte
  of observable production behaviour. Confirmed by `npm run build`
  passing and by re-reading the diff for behavioural changes.
- The `dotenv/config` import stays in `index.ts` only. Tests that
  import `@/app` get the env they explicitly set, not whatever happens
  to be in `.env` — which they shouldn't depend on anyway.
- `tsconfig.json`, build scripts, Dockerfile entrypoint — all
  unchanged. The `Dockerfile`'s `CMD ["node", "dist/index.js"]` still
  works because `index.ts` still binds the port.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A route module reads `process.env` at top-level import order | Imports stay in source order; only the wrapping changes. `tsc` + a manual smoke check are the gate. |
| Tests import `@/app` before stubbing env, so limiters / static-bundle detection see the wrong values | Per-call construction inside `buildApp()` means env reads happen at call time. |
| Dependency-injection creep (taking `db`, `llm`, etc. as `buildApp` params) | Resisting in this slice. `buildApp` is parameter-less. Routes still reach for module singletons; tests mock at the module boundary, the same pattern `middleware/auth.test.ts` already uses. Revisit only if a specific route resists mocking. |

### Route-test queue (post-split)

11. ~~`src/routes/auth.ts`~~ — done. 37 tests covering local-login
    (404 unless local mode, mints HS256 token verifiable against
    JWT_SECRET, deterministic UUID from email), provider listing,
    sign-out (entra → MSFT logout, defensive fallback when
    misconfigured), `/login-provider/microsoft` (state HMAC verified
    against AUTH_STATE_SECRET, open-redirect guard on returnUrl,
    selectAccount→prompt mapping, ENTRA_REDIRECT_URI override), and
    `/openid-callback/microsoft` (every state-failure mode rejects
    with 400, every exchange-failure redirects to /login?error=…
    rather than 5xx-ing).
12. ~~`src/routes/config.ts`~~ — done. 13 tests pinning the JSON
    shape, the AUTH_PROVIDER allow-list (anything not entra/local
    clamps to supabase), and a secret-leak guard that puts placeholder
    secrets into every server-only env var and asserts none of them
    appear in the response body.
13. ~~`src/routes/downloads.ts`~~ — done. 13 tests pin requireAuth
    wiring (401 without header, forwards provider failures), short-
    circuit on invalid token (no DB or storage call), version-not-
    found / doc-not-found 404s, the access-deny path returning 404
    (NOT 403 — refuses to leak existence), the storage-returns-null
    case (deleted blob), and MIME mapping for pdf/docx/xlsx/case-
    insensitive/octet-stream fallback.
14. ~~`src/routes/user.ts`~~ — done. 28 tests covering GET /profile
    (canonical shape, global-API-keys booleans-without-values, secret-
    leak guard on env vars, profile-read 500), PATCH /profile (no-op
    rejection, profile updates with updated_at stamp, flat-key
    set/delete, azure compound merge, azure clear-both → delete,
    azure clear-one → 400, every 500 path), POST credits/increment
    (default null→0, read/update 500s), DELETE /account (entra-mode
    403, FK-safe table order, stop-on-first-error with table-named
    message, optional workflow_shares-by-email cleanup).
15. `src/routes/documents.ts`, `projects.ts`, `tabular.ts`, `chat.ts`,
    `projectChat.ts`, `workflows.ts` — domain routes; tenant scoping
    at the boundary is the headline assertion.
16. `src/routes/llm.ts`, `diagnostics.ts`, `diag.ts`, `install.ts` —
    operator and meta routes.

### Per-route checklist

For each route file, the test should pin at least:

- **Wiring**: `requireAuth` is applied (or deliberately omitted, e.g.
  `/config`, `/diag`). 401 with no header, 200/expected with a header.
- **Tenant scoping**: a request whose principal has tenant A cannot
  read a resource from tenant B. The deny path returns 403/404 with
  no leak of resource existence.
- **Validation**: malformed JSON / wrong content-type / oversized
  bodies get 400, not 500.
- **Downstream errors**: the DB or LLM throwing should produce a
  mapped 5xx, not crash the server.
- **Response shape**: assert the keys in the response body — a
  reviewer should be able to recover the API contract from the test.

## 8. Definition of done per module

A module is considered "covered" when:

- Every exported function has at least one test.
- Every error/branch is exercised — `if`/`else`/`switch`/`catch`/
  `await ... rejects.toThrow`.
- Security-relevant invariants (auth, tenant scoping, signature
  verification, redaction of secrets in logs) have explicit
  *negative* tests, not just positive ones.
- A reviewer reading the test file can recover the module's contract
  without reading the source.
- Line coverage ≥ 90% **and** branch coverage ≥ 85% (uncovered lines
  are listed in §6 with a one-line reason).

A test is rejected if it would still pass after silently breaking the
function under test (mutation-test-by-eyeball). Examples of red-flag
patterns the reviewer should reject:

- `expect(x).toBeTruthy()` as the only assertion.
- Snapshot of mock-return data the test itself constructed.
- A test that mocks the function it claims to be testing.
- A "happy path only" test for a function that has explicit error
  handling.

## 9. Frontend handoff

The frontend suite is a separate effort, intentionally split off so it
can be developed against its own focused prompt and merged as its own
PR. See `docs/testing/frontend-test-suite-prompt.md` for the brief.

### Why split

The frontend stack (Next.js 16 App Router, React 19, jsdom, RTL, MSW)
is meaningfully different from the backend's Express/Node world. A
single PR that mixes both would be hard to review, and the two test
files would share no code. The backend suite proved that
prompt-first authoring produces disciplined output; we want the same
flywheel for the frontend.

### Hand-off contract

When the new session picks up the frontend work:

1. It branches from `main` after this backend work has landed there.
   The conventional branch name is `claude/typescript-testing-frontend`.
2. It reads `frontend-test-suite-prompt.md` as its brief.
3. It reads this regime doc for the convention library — particularly
   §3 (Conventions), §4 (Patterns), §8 (Definition of done), §7a
   (the `src/app.ts` split — the prompt-first / split-before-test
   discipline carries over).
4. It surveys `frontend/` and starts at the bottom of the dependency
   graph (`src/lib/auth-token.ts`, then the three contexts, then
   hooks, then `mikeApi.ts`, then components).
5. It updates this regime doc (§6 coverage manifest, §9 change log)
   per slice, the same way the backend slices did.

### Shared invariants between the two suites

These apply equally to both sides and the frontend prompt repeats
them — keeping them listed here too so a reader hitting the regime
first knows what to expect:

- **Substantial tests, not Mickey Mouse.** A test that would still
  pass after the function under test is silently broken is rejected.
- **No real network, DB, or browser engine traffic.** MSW intercepts
  on the frontend; module mocks intercept on the backend.
- **Real crypto where possible.** The backend's auth-provider tests
  generate RSA keys and sign tokens; the frontend should similarly
  not stub `crypto.subtle` for token-shaping code if it's added
  later.
- **One latent bug per slice is a win, not a problem.** Pin it,
  document it (`user.ts` rolling block is the worked example), and
  let the future refactor break the pin deliberately.

## 10. Change log

- **2026-05-14** — Initial regime. Vitest bootstrap; `access.ts`,
  `middleware/auth.ts`, `tenantAccess`, `requireRole`, `auth/roles`,
  all three auth providers, `downloadTokens`, `userApiKeys`,
  `userSettings`, and `config` covered.
- **2026-05-14** — `src/app.ts` split landed; route suite kicked off
  with `routes/auth.ts`, `routes/config.ts`, `routes/downloads.ts`,
  and `routes/user.ts`. Suite stands at **312 tests** across 16
  files, all green, ~4s total runtime. Discovered (and pinned) one
  latent bug along the way: `user.ts` GET /profile's credit-rolling
  block is unreachable because `normalizeCreditsResetDate` rewrites
  past dates before the rolling check sees them.
- **2026-05-14** — Frontend handoff prepared.
  `docs/testing/frontend-test-suite-prompt.md` authored as the brief
  for a new session that will land the frontend suite on its own
  branch off main.
- **2026-05-14** — Frontend test harness bootstrapped on branch
  `claude/frontend-test-suite-prep-8y3gI`. Added Vitest 4 + jsdom +
  React Testing Library + MSW v2; `frontend/vitest.config.ts`;
  `frontend/src/test/{setup,msw-server,render}.{ts,tsx}`; one harness
  smoke test (2 assertions, green in ~1.2s). Two production-code
  changes: `ConfigContext` and `AuthContext` are now `export`ed from
  their source files so the test render helper can inject context
  values without re-running the providers' real effects (no
  behaviour change; consumers still use the `useConfig` / `useAuth`
  hooks). See §11 for the frontend plan.
- **2026-05-14** — `src/lib/auth-token.ts` covered. 25 tests,
  100/100/100 coverage. Suite stands at **27 tests** across **2
  files**, ~1.3s runtime. No latent bugs found this slice — the
  module is small enough that every branch was already correct;
  the test value is forward-looking (the localStorage key contract
  is now reviewer-readable from the test file alone).
- **2026-05-14** — `src/contexts/ConfigContext.tsx` covered. 14
  tests, 100% lines / 100% funcs / 88% branches (the two missed
  branches are the SSR guards in private helpers — unreachable from
  a `"use client"` module). Suite stands at **41 tests** across **3
  files**, ~1.4s runtime. First slice that uses the real provider
  with MSW responding — the harness pattern is confirmed.
- **2026-05-14** — `src/contexts/AuthContext.tsx` covered. 27
  tests, 100/100/93 (lines / funcs / branches). All three provider
  modes pinned end-to-end against the real provider — supabase
  with a fake client, local + entra with localStorage + MSW. Suite
  stands at **68 tests** across **4 files**, ~2.4s runtime. No
  latent bugs found; the `decodeJwtUser` claim fallback chain
  surface is now reviewer-readable from the test file alone.
- **2026-05-14** — `src/contexts/UserProfileContext.tsx` covered.
  19 tests, 100% lines / 100% funcs / 84% branches. The biggest
  context (444 LOC) — pins the bootstrap fetch shape, the offline
  fallback profile, the `authedFetch` wiring (including the
  `bounceIfUnauthorized` integration), AOAI deployments lifecycle,
  every update function's normalisation + state-merge semantics
  (especially `updateAzureOpenaiSettings`'s per-key membership
  rule), and the 0-credits-remaining / no-profile / no-user
  short-circuits. Suite stands at **87 tests** across **5 files**,
  ~2.7s runtime. No latent bugs found.
- **2026-05-14** — Two small hooks covered:
  `useSelectedModel` (8 tests — symmetric read/write allow-list,
  AOAI prefix acceptance, useCallback stability) and
  `useGenerateChatTitle` (4 tests — happy-path call sequence +
  best-effort error swallow on either step). Suite stands at **99
  tests** across **7 files**, ~3.6s runtime.
- **2026-05-14** — Three doc-loading hooks covered in one slice:
  `useDocumentVersions` (11 tests), `useFetchSingleDoc` (9 tests),
  `useFetchDocxBytes` (9 tests). 29 tests total, 100% lines / 95%
  funcs / 85% branches across the three. Pinned each hook's
  dedupe / cache strategy and the shared auth-header + 401-bounce
  contract. **Finding:** `useFetchDocxBytes` ships a `console.log`
  at line 50 that is debug noise (no real diagnostic value once
  the suite is green) — flagged for a follow-up cleanup commit,
  not pinned in tests because asserting "no console.log" is
  brittle. Suite stands at **131 tests** across **10 files**,
  ~5s runtime.
- **2026-05-14** — `src/app/hooks/useAssistantChat.ts` covered.
  40 tests, 93/83/93 (lines / branches / funcs). The biggest
  hook in the codebase (956 LOC) — pins the surface contract
  (input validation, client routing, error / cancel / new-chat),
  the SSE protocol every event type at a time
  (`chat_id`, `content_*`, `reasoning_*`, `tool_call_start`,
  `workflow_applied`, `doc_read*`, `doc_find*`, `doc_created*`,
  `doc_download`, `doc_replicate*`, `doc_edited*`, `citations`),
  and the 16ms `setInterval` drip animation via
  `vi.useFakeTimers`. **Finding:** the `content_delta` events
  carry incremental fragments, not cumulative state — pinning
  this saved a refactor that would have produced visible
  duplicated text on every reply. Suite stands at **172 tests**
  across **11 files**, ~5.6s runtime.
- **2026-05-14** — `src/app/lib/mikeApi.ts` covered. 82 tests,
  100% lines / 100% funcs / 94% branches. 880-LOC client; the
  seam where backend changes most often break the frontend
  silently. Detailed pins on `apiRequest`, the streaming helpers,
  FormData uploads, the `getChat` server→client message
  transform, and `mapTRMessages`; smoke coverage on every CRUD
  wrapper (projects, folders, versions, chats, tabular review,
  workflows). Two MSW/jsdom v2 quirks caught and worked around in
  the harness: `formData().get("file").name` is "" not the
  original filename (assert on field presence instead); `Blob`
  instances cross realms and fail `instanceof` checks (duck-type
  on `size` + `arrayBuffer()` instead). Suite stands at **254
  tests** across **12 files**, ~5.7s runtime.

## 11. Frontend toolchain

| Concern | Tool | Why |
| --- | --- | --- |
| Runner | **Vitest 4** | Same runner as the backend; TS + ESM first-class; no `ts-jest` or babel-jest. |
| Env | **jsdom 27** | A DOM in Node. Real browser quirks belong in a Playwright suite, not here. |
| Render | **@testing-library/react 16** | RTL 16 is the first React 19-compatible release. |
| User input | **@testing-library/user-event 14** | Dispatches the full event sequence a real user produces; preferred over `fireEvent`. |
| Matchers | **@testing-library/jest-dom 6** | `toBeInTheDocument`, `toHaveTextContent`, etc. Imported via the `/vitest` subpath in `setup.ts`. |
| Network | **MSW 2** | Intercepts `fetch` at the network layer. Tests exercise the real `mikeApi.ts` code path, not a stubbed wrapper. `onUnhandledRequest: "error"` so a forgotten handler fails loudly. |
| Path aliases | **vite-tsconfig-paths** | Resolves `@/*` from `tsconfig.json`. (Vite 7 has a native option; keeping the plugin for symmetry with the backend config and to avoid a one-off divergence.) |
| Coverage | **@vitest/coverage-v8** | Built-in, accurate branch counts. |
| React | **@vitejs/plugin-react** | JSX transform + the React Compiler babel plugin the production build uses, so test behaviour matches prod. |

Config lives in `frontend/vitest.config.ts`. Setup, MSW handlers,
and the render helper live in `frontend/src/test/`. Test files are
co-located with sources (`Foo.tsx` → `Foo.test.tsx`).

Run from `frontend/`:

```bash
npm test                  # one-shot
npm run test:watch        # interactive
npm run test:coverage     # one-shot + v8 coverage (html, text, lcov)
```

The conventions in §3 carry over verbatim (explicit imports of
`describe`/`it`/`expect`/`vi`, AAA layout, one behaviour per test,
no real network/clocks). The full frontend-specific list — including
the prohibition on `data-testid` for production elements, the
"`waitFor` around a sync expectation" anti-pattern, etc. — is in
`frontend-test-suite-prompt.md` §8 and §11.

### Production-code changes

The frontend suite landed exactly one production-code change in its
bootstrap commit: `ConfigContext` and `AuthContext` are now exported
from their source files. Without that, the test render helper would
have to use the real providers, which fire effects (a `/config`
`fetch`, a supabase client construction, an Entra URL-hash decode)
that turn every render call into an integration test. Exporting the
context objects lets the helper inject context values directly —
zero behaviour change for production consumers (they still go
through `useConfig` / `useAuth`). Mirrors the backend's `app.ts`
split discipline: a small, documented refactor before the slice
that needs it.

## 12. Frontend queue

Ordered bottom-up — pure modules first, then the contexts that
others depend on, then hooks, then the API client, then components.
Pages and middleware are out of scope per `frontend-test-suite-prompt.md`
§5.

1. ~~Harness bootstrap~~ — done (this commit). Vitest config,
   setup, MSW server, render helper, smoke test.
2. ~~`src/lib/auth-token.ts`~~ — done. 25 tests, 100/100/100. Pins
   the four localStorage key literals, the provider fork in
   `getBrowserAccessToken` (entra/local/supabase + supabase-factory-
   throws fallthrough + getSession rejection), `clearStoredAuthState`'s
   scope (entra+local only — leaves `mike.config.authProvider` and
   unrelated keys untouched), and `bounceIfUnauthorized`'s
   idempotent no-redirect-when-already-on-`/login` behaviour. Three
   SSR / no-window tests close the defensive `typeof window === "undefined"`
   branches.
3. `src/lib/utils.ts`, `src/lib/slug.ts`, `src/lib/label.ts` — tiny
   pure modules. Cover only if there's real logic; skip the
   one-liners and document why in §13.
4. ~~`src/contexts/ConfigContext.tsx`~~ — done. 14 tests, 100% lines
   / 100% funcs / 88% branches. Used the real provider with MSW
   driving `/config`. Pins the cache→fetch→cache round-trip, the
   input allow-list, the failed-fetch fallback, and the cancelled-
   effect guard. Two SSR branches in private helpers are unreachable
   from a `"use client"` module; documented in §13.
5. ~~`src/contexts/AuthContext.tsx`~~ — done. 27 tests, 100/100/93.
   Pins all three modes against the real `AuthProvider`: supabase
   subscription + unsubscribe, local stored-user restore + corrupt-
   JSON cleanup, entra URL-hash token + `decodeJwtUser` claim
   fallback chain, per-mode `signOut`, `useAuth` outside provider
   throws. Three uncovered branches are deep defensive fallbacks.
6. ~~`src/contexts/UserProfileContext.tsx`~~ — done. 19 tests, 100%
   lines / 100% funcs / 84% branches. Pins the snake→camel mapping
   + defaults, the offline-tier fallback, the `authedFetch`
   wiring, AOAI deployments lifecycle, every update function's
   normalisation rule, the per-key membership semantics on the
   azure patch, the credits-remaining short-circuit, and the
   no-user / no-profile guards on each updater.
7. ~~`useSelectedModel.ts`, `useGenerateChatTitle.ts`~~ — done.
   12 tests total. Both pinned with their respective fallback /
   swallow semantics. See §13 entries.
8. ~~`useDocumentVersions.ts`, `useFetchSingleDoc.ts`,
   `useFetchDocxBytes.ts`~~ — done in one commit (small enough to
   group). 29 tests total. All three pin the auth header + 401
   delegation pattern; each pins its specific dedupe (refresh
   tick / prevKeyRef / module-level cache + in-flight Promise).
   Caught a leftover `console.log` in `useFetchDocxBytes`; not
   pinned but noted in §13 for a follow-up.
9. ~~`src/app/hooks/useAssistantChat.ts`~~ — done. 40 tests, 93/83/93
   (lines / branches / funcs). The deep SSE coverage and drip
   animation are in this single slice; no follow-up needed.
10. ~~`src/app/lib/mikeApi.ts`~~ — done. 82 tests, 100/94/100 (lines
    / branches / funcs). Detailed contract pins on `apiRequest`,
    the streaming helpers, FormData uploads, the `getChat`
    transform, and `mapTRMessages`; smoke coverage on every CRUD
    wrapper. The seam most likely to silently break under a backend
    refactor is now reviewer-readable from the test file alone.
8. `src/app/hooks/useAssistantChat.ts` — 956 lines, last in the
   hook queue. Stream handling, abort logic, error mapping. Slice
   into multiple commits if the test file grows past ~600 lines.
9. `src/app/lib/mikeApi.ts` — 880 lines, the seam most likely to
   regress when the backend contract changes. URL construction,
   header injection, the 401 → bounce-to-login flow, error
   envelope mapping. Tests exercise the real client through MSW.
10. **Component pass.** Sample set, NOT every component:
    `components/ui/button.tsx` (smoke; primitive), `chat/mike-icon.tsx`
    (if non-trivial), then `EmailPillInput`, `DocumentCard`,
    `DocViewModal`, `PeopleModal`, `OwnerOnlyModal`, `ToolbarTabs`,
    `RenameableTitle`, `VersionChip`, `RowActions`, `ApiKeyMissingModal`,
    `ProjectPicker`, then `tabular/{TRTable,TREditColumnMenu,AddColumnModal,
    AddNewTRModal,TRChatPanel,TRSidePanel}`. Heavy viewers (PDF,
    docx-preview, tiptap, recharts) are mocked at the module
    boundary per `frontend-test-suite-prompt.md` §7; their wrappers
    are tested for "right src is passed in", not "PDF renders".
11. Pure helpers under `src/app/components/tabular/*`
    (`pillUtils.ts`, `prompt-generator.ts`, `columnFormat.ts`,
    `exportToExcel.ts`, `citation-utils.ts`, `columnPresets.ts`) —
    no React, easy wins.

Each entry lands as one commit (`test(frontend/...)` prefix).
Coverage manifest in §13 updated each time. Latent bugs found
along the way get pinned in place and called out in the change log
(§10) — same discipline as the backend's `user.ts` rolling-block
pin.

## 13. Frontend coverage manifest

| File | Tests | Stmts | Branch | Funcs | Notes |
| --- | --- | --- | --- | --- | --- |
| `src/test/harness.test.tsx` | 2 | n/a | n/a | n/a | Harness smoke. Excluded from coverage. |
| `src/lib/auth-token.ts` | 25 | 100 | 100 | 100 | Pins the four localStorage key literals, the provider fork in `getBrowserAccessToken` (entra/local/supabase + supabase-factory-throws fallthrough + getSession rejection), `clearStoredAuthState`'s scope (entra+local only — leaves `mike.config.authProvider` and unrelated keys untouched), and `bounceIfUnauthorized`'s idempotent no-redirect-when-already-on-/login behaviour. Three SSR / no-window tests close the defensive `typeof window === "undefined"` branches in all three functions. |
| `src/contexts/ConfigContext.tsx` | 14 | 94 | 88 | 100 | Pins the cache→fetch→cache round-trip with `auth-token.ts` (same `mike.config.authProvider` key both sides read/write), the input allow-list (`entra`/`local`/`supabase` only — anything else clamps to `supabase`), the failed-fetch fallback (cache survives a 5xx or a network error; `loading` still flips to `false`; `console.warn` is the only side effect), and the cancelled-effect guard that prevents a late `/config` response from overwriting state on an unmounted provider. Lines 44 + 53 uncovered: the SSR guards in `readCachedProvider`/`writeCachedProvider` — structurally unreachable because the file is `"use client"`. |
| `src/contexts/AuthContext.tsx` | 27 | 99 | 93 | 100 | Pins all three provider modes against the real `AuthProvider`. Supabase: initial `getSession`, `onAuthStateChange` sign-in/sign-out, `unsubscribe()` on unmount, `signOut` delegation. Local: stored-user restore, corrupt-JSON cleanup (drops the paired token too), `signInLocal` POST shape (body, content-type, error-body throw), `signOut` clears both keys. Entra: URL-hash token extraction, `decodeJwtUser` claim fallback chain (`oid`→`sub`, `preferred_username`→`email`→`upn`), email lower-casing, history-replaceState fragment strip, corrupt-stored-user cleanup, `signOut` redirects through backend `/auth/logout`. `useAuth` outside a provider throws. The gating on `configLoading` (no auth flow runs until config is ready) and `getAccessToken`'s delegation to `auth-token.ts` are both pinned. Three remaining uncovered branches are defensive fallbacks (no-dot JWT, email-empty fork on a different code path) — well over threshold. |
| `src/contexts/UserProfileContext.tsx` | 19 | 98 | 84 | 100 | Pins the snake_case→camelCase profile mapping (with `tier`→`"Free"` and `tabular_model`→`"gemini-3-flash-preview"` defaults, credit math, boolean coercion on `global_api_keys`), the offline 30-day-future-tier fallback when `/user/profile` 5xxs, the unauthenticated path (no network, profile=null), the `authedFetch` wiring (Authorization header injection + `bounceIfUnauthorized` call on every response + token-null edge case), AOAI deployments auto-fetch + reload-on-failure + the `err instanceof Error` message extraction, every update function (`displayName`/`organisation`/`modelPreference`/`apiKey` with trim-whitespace→null + DB column mapping; `azureOpenai` with per-key `"key" in patch` membership semantics + empty-patch fast-path + post-save deployments reload), `incrementMessageCredits`'s 0-credits-remaining short-circuit and pre-profile-load guard, every `catch { return false; }` failure path, and `useUserProfile` outside a provider throws. Remaining branch gaps are deep inside the AOAI merge ternaries — both sides hit across the suite but not all four keys cross-checked. |
| `src/app/hooks/useSelectedModel.ts` | 8 | 94 | 80 | 100 | Pins the localStorage allow-list (read-time rejects unknown ids back to `DEFAULT_MODEL_ID`, write-time clamps unknown inputs the same way — neither path can leave storage in an invalid state), the `aoai:` prefix acceptance for runtime-named deployments, and the setter's `useCallback([])` stability across renders. SSR guards uncovered (defensive; hook is `"use client"`). |
| `src/app/hooks/useGenerateChatTitle.tsx` | 4 | 100 | 100 | 100 | Pins the happy-path call sequence (`generateChatTitle` → `renameChat` with the returned title) plus the best-effort error swallow on either step. Title generation must never break the chat — both reject paths resolve undefined and don't propagate. |
| `src/app/hooks/useDocumentVersions.ts` | 11 | 100 | 95 | 100 | Pins the disabled-on-null behaviour, the fetch lifecycle (Authorization header injection + `HTTP {status}` error envelope + missing-keys fallback to `[]`/`null`), the three refetch triggers (`documentId` change, `refreshKey` change, the `refresh()` callback's internal tick), the clear-on-null transition, and the cancelled-effect guards on both the success and error paths. |
| `src/app/hooks/useFetchSingleDoc.ts` | 9 | 96 | 80 | 100 | Pins the content-type branching (PDF → buffer; anything else → `{ type: "docx" }` so the caller falls through to `DocxView`), the `prevKeyRef` dedupe (rerenders with the same `(documentId, versionId)` skip the fetch entirely), the `encodeURIComponent` query-string encoding, the generic user-facing error string (`"Failed to load document."` — never the raw HTTP code), the `bounceIfUnauthorized` delegation, and the cancellation guard on unmount. |
| `src/app/hooks/useFetchDocxBytes.ts` | 9 | 97 | 100 | 100 | Pins the fetch lifecycle, the module-level cache (same-key remounts return bytes synchronously with no spinner), separate-key isolation (`(docId, versionId, refetchKey)` is the cache key), `refetchKey` forcing a refresh, `invalidateDocxBytes(docId, versionId)` evicting a single tuple, `invalidateDocxBytes(docId)` evicting every version, the in-flight `Promise` dedupe (two simultaneous mounts share one network request), and the clear-on-null transition. **Finding:** the hook has a leftover `console.log` at line 50 — debug noise that should be removed in a follow-up. Not pinned (it's noise, not a contract). |
| `src/app/hooks/useAssistantChat.ts` | 40 | 93 | 83 | 93 | 956-LOC hook; the largest in the codebase. Pins the public-facing contract: input validation (whitespace guard on `handleChat` and `handleNewChat`), the `streamChat` vs `streamProjectChat` routing, `displayed_doc` shaping, the `attached_documents` filter (only files with `document_id`, undefined when the filtered list is empty), the SSE `chat_id` event (sets state, `setCurrentChatId`, `router.replace(...)`, `generateTitle` on first-message new chats), `content_delta` incremental-fragment accumulation through the drip + final `flushDrip()` commit, the `content_done` / `citations` end-of-stream signals, malformed-JSON line resilience (parser warns + stream continues), HTTP non-2xx → assistant `error` field, `cancel()` aborts and writes a "Cancelled by user" content event, the dedupe guard against double-appending an already-last user message, and `loadChats` + `replaceChatId` history side-effects. Deep SSE coverage: `reasoning_delta` (start + append branches; both `text` accumulation and the cross-event finalisation from `finalizeStreamingReasoning`), `reasoning_block_end`, `tool_call_start`, `workflow_applied`, `doc_read_start`/`doc_read`, `doc_find_start`/`doc_find` (including the omit-total_matches preserve-prior branch), `doc_created_start`/`doc_download`/`doc_created`, `doc_replicate_start`/`doc_replicated` (with copies-as-count fallback and error-string passthrough), `doc_edited_start`/`doc_edited`. The 16ms `setInterval` drip animation is exercised with `vi.useFakeTimers` — 8 chars per tick, observed at 16ms / 32ms / 48ms boundaries. |
| `src/app/lib/mikeApi.ts` | 82 | 99 | 94 | 100 | 880-LOC client; **the seam where backend changes most often break the frontend silently**. Detailed pins on the `apiRequest` wrapper: URL prefix construction, `Authorization: Bearer <token>` injection (omitted when the token is null), `Accept: application/json` default + per-call `Content-Type` override merge, `bounceIfUnauthorized` call on every response, response-text → `Error.message` mapping on non-2xx with the `"API error: ${status}"` fallback when the body is empty, undefined return for 204 and `Content-Length: 0`. Detailed pins on `getChat`'s server→client message transform (user messages with `null` content map to `""`; assistant messages join `content`-type events into a plain `content` string and preserve the full `events` array; non-array assistant content is the legacy-row branch that maps to empty content + undefined events). Detailed pins on the streaming helpers (`streamChat`/`streamProjectChat`): `Accept: text/event-stream`, the `signal` is destructured out of the body, the returned `Response` carries a `ReadableStream`, `bounceIfUnauthorized` fires before the caller reads. Detailed pins on the FormData upload helpers (no `Content-Type` override — fetch derives the multipart boundary; optional fields like `display_name` are only appended when set). Smoke coverage of every CRUD wrapper (projects, folders, document versions, chats, tabular review CRUD + chat + cells, workflows + shares + hidden + visibility) — each test pins path + method + body shape so a typo or wrong verb fails loudly. `mapTRMessages` pure helper covered separately for the same content-join contract as `getChat`. |

(Filled in per slice as the queue advances.)

## 14. Frontend definition of done

Inherited from `frontend-test-suite-prompt.md` §14 and the backend
DoD in §8 — repeated here so a future agent doesn't have to flip
between docs:

- `npm test` passes with zero skipped tests.
- `npm run test:coverage` clears the prompt §10 thresholds
  (`src/contexts/**`, `src/lib/**`, `src/app/hooks/**`,
  `src/app/lib/**` ≥ 80% line + branch; UI components ≥ 70%).
- No test fires a real network request (`onUnhandledRequest: "error"`
  in MSW catches this; a green suite proves it).
- No test reads from real `localStorage` left over from a previous
  run (`setup.ts` clears both storages in `afterEach`).
- Every interactive component has at least one test that exercises
  a real user gesture (click, type, focus, keyboard nav) and
  asserts the resulting state / call / navigation.
- This regime doc is updated (§10 + §13 minimum).
