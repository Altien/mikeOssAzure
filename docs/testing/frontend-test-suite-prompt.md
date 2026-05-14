# Frontend TypeScript Test Suite — Authoring Prompt

This document is a **prompt template** for an AI coding agent (e.g. Claude
Code) tasked with building, expanding, or maintaining the frontend
unit-test suite for `frontend/`. It mirrors the structure of
`backend-test-suite-prompt.md` and inherits the same discipline:
substantial behavioural tests, not Mickey-Mouse smoke tests.

Pair this prompt with `docs/testing/regime.md`, which tracks what's
covered and what's queued. Update the regime after each module.

---

## 1. Goal

Produce a comprehensive, maintainable unit-test suite for the
Next.js 16 + React 19 frontend in `frontend/`. Tests must be fast,
deterministic, and isolated from the real backend, the real Supabase
project, the real Entra tenant, and the real browser. Coverage is a
means, not the goal — every test must assert behaviour a future
developer could plausibly break by refactoring.

The frontend talks to the same backend that the backend suite already
covers; **do not retest backend logic from the frontend**. The frontend
suite's job is to pin the UI contract: rendered output, user
interactions, hook behaviour, context wiring, and the way the client
maps user actions to API calls and API responses to rendered state.

## 2. Runner & tooling — Vitest + jsdom + RTL + MSW

Use **Vitest** with the **jsdom** environment. Same runner as the
backend so engineers swing between the two suites without retraining.
The frontend deliberately does *not* use Jest — TypeScript and ESM
support are first-class in Vitest, no `ts-jest` or babel-jest hoops.

### Required dev dependencies

Add to `frontend/package.json` `devDependencies`:

- `vitest`
- `@vitest/coverage-v8`
- `vite-tsconfig-paths` — resolves the `@/*` alias.
- `jsdom`
- `@testing-library/react`
- `@testing-library/user-event` — preferred over `fireEvent` because
  it dispatches the full sequence of events a real user produces.
- `@testing-library/jest-dom` — adds the `toBeInTheDocument`,
  `toHaveTextContent`, etc. matchers.
- `msw` (Mock Service Worker) — intercepts `fetch` at the network
  layer. **Strongly preferred** over per-test `vi.fn(fetch)` mocking
  because the suite then exercises the real client code path through
  `mikeApi.ts` and reads/asserts the actual request URL, headers, and
  body — exactly what a refactor of the client could break.

### Scripts

Add to `frontend/package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

Do not wire `npm test` into the existing `build` or `dev` scripts —
the suite stays a separate command so CI can fail-fast on tests
without rebuilding the bundle.

### Config

Create `frontend/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/test/**",
        "src/app/**/page.tsx",  // server components, see §5
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/not-found.tsx",
        "src/app/**/global-error.tsx",
        "src/**/*.d.ts",
      ],
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
```

Also add `@vitejs/plugin-react` to dev deps. It enables JSX
transformation and (via SWC) the React Compiler babel plugin that
the production build relies on, so test behaviour matches prod.

### Test file location

Co-locate tests with source:
- `src/components/chat/MessageList.tsx` → `src/components/chat/MessageList.test.tsx`
- `src/contexts/AuthContext.tsx` → `src/contexts/AuthContext.test.tsx`
- `src/app/hooks/useDocumentVersions.ts` → `src/app/hooks/useDocumentVersions.test.ts`
- `src/app/lib/mikeApi.ts` → `src/app/lib/mikeApi.test.ts`

## 3. The setup file

`frontend/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, afterAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw-server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
```

`onUnhandledRequest: "error"` is deliberate: a test that fires an
unmocked request fails loudly rather than silently hitting whatever
`fetch` returns by default in jsdom. **Every** outgoing request must
have a handler.

## 4. MSW server

`frontend/src/test/msw-server.ts`:

```ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// Default handlers cover the bootstrap requests that every render
// fires (so individual tests don't have to re-stub them). Tests that
// care about /config or /auth/providers responses override these via
// server.use(...).
export const handlers = [
  http.get("*/config", () =>
    HttpResponse.json({
      authProvider: "supabase",
      entra: { tenantId: "", clientId: "" },
    }),
  ),
  http.get("*/api/auth/providers", () =>
    HttpResponse.json({
      defaultProvider: "supabase",
      providers: [
        { id: "microsoft", name: "Microsoft", mode: "openid", enabled: false },
      ],
    }),
  ),
];

export const server = setupServer(...handlers);
```

The `*/path` patterns match both same-origin (`/config`) and
absolute-URL (`https://api.example.com/config`) requests, so the same
handler covers both `NEXT_PUBLIC_API_BASE_URL` shapes.

## 5. Server vs client components

Next.js App Router mixes server components (`page.tsx`, `layout.tsx`,
default RSCs) with client components (`"use client"` files). The
suite policy:

- **Client components** (`"use client"`) — test directly with React
  Testing Library. This includes every file in `src/contexts/`,
  `src/components/`, `src/app/hooks/`, and any client page leaf.
- **Server components** — **do not unit-test**. They're async,
  RSC-only, and would require running the Next.js runtime. Instead:
  - Extract the pure data-fetching part into a function in
    `app/lib/` and test *that* with MSW.
  - Extract the rendered UI into a client component sibling and test
    *that* with RTL.
  - If a server component is just `return <ClientThing initial={data} />`,
    it doesn't need its own test — the constituent functions cover it.
- **Routing / middleware** — `middleware.ts` (if added) and route
  handlers under `app/api/` are server-side; treat them like the
  backend tests (mock the fetch boundary, no real `next/server`
  runtime).

These exclusions are already encoded in `vitest.config.ts` coverage
config. Don't fight that — extract the testable pieces instead.

## 6. Render helpers

`frontend/src/test/render.tsx` consolidates the three contexts the
app wraps everything in:

```tsx
import { ReactElement, ReactNode } from "react";
import { render, RenderOptions } from "@testing-library/react";
import { ConfigContext } from "@/contexts/ConfigContext";
import { AuthContext } from "@/contexts/AuthContext";

type Opts = {
  config?: Partial<RuntimeConfig>;
  user?: { id: string; email: string } | null;
} & Omit<RenderOptions, "wrapper">;

export function renderWithProviders(ui: ReactElement, opts: Opts = {}) {
  const config = { authProvider: "supabase", entra: { tenantId: "", clientId: "" }, ...opts.config };
  const auth = {
    user: opts.user ?? null,
    isAuthenticated: opts.user !== null,
    authLoading: false,
    signInLocal: async () => {},
    signOut: async () => {},
    getAccessToken: async () => (opts.user ? "fake-token" : null),
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ConfigContext.Provider value={{ config, loading: false }}>
        <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
      </ConfigContext.Provider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...opts });
}
```

A new test that needs a different provider value calls
`renderWithProviders(<Thing />, { user: {...}, config: { authProvider: "entra" } })`.

## 7. Mocking strategy

### Network → MSW only

Every request that leaves the bundle goes through `fetch` (directly
or via `mikeApi.ts`). Mock it with MSW handlers, not with
`vi.fn(globalThis.fetch)`. Reasons:

- Tests then exercise the real `mikeApi.ts` code path — URL
  construction, header injection, JSON serialisation, error mapping —
  which is exactly the layer most likely to regress.
- Switching the request library (e.g. to `ky`) becomes a one-file
  change rather than a sprawling test refactor.
- MSW reports unhandled requests, which catches "I forgot to mock the
  new endpoint" instead of silently fetching `undefined`.

### Next.js router → `vi.mock("next/navigation", ...)`

```ts
const { useRouter, usePathname, useSearchParams } = vi.hoisted(() => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock("next/navigation", () => ({ useRouter, usePathname, useSearchParams }));
```

Pass spies (`push: vi.fn()`, `replace: vi.fn()`) so tests can assert on
navigation calls.

### Supabase client → mock `@/lib/supabase`

The client is only constructed at runtime in supabase auth mode.
Mock the factory so tests in any auth mode can run without the env
vars being present.

### Heavy viewers (pdfjs-dist, tiptap, docx-preview) → mock at the module boundary

```ts
vi.mock("@/components/pdf-viewer", () => ({
  default: ({ src }: { src: string }) => <div data-testid="pdf-viewer-stub">{src}</div>,
}));
```

Don't try to render PDFs in jsdom. Test that the right *src* is
passed; trust pdfjs-dist itself.

### localStorage → no mock, just clear in afterEach

Already in `setup.ts`. Tests can assert on `window.localStorage.getItem(...)`
directly — this is exactly the behaviour the `auth-token.ts` module
relies on.

## 8. Conventions

Carried verbatim from the backend prompt:

- **Explicit imports** of `describe`/`it`/`expect`/`vi` —
  `globals: false`.
- **Arrange / Act / Assert** with blank-line separation.
- **One behaviour per test**; multiple `expect` calls describe the
  same outcome.
- **No `Date.now`/`Math.random`/`setTimeout` without fake timers**.
- **`screen.getBy*` for elements that must exist; `queryBy*` for
  assertions that they don't**. `findBy*` for async appearance.
- **No `act(...)`** unless RTL specifically asks. RTL's helpers wrap
  it for you.
- **No `data-testid` on production elements just to make a test
  easier** — find by role, label, or visible text. `data-testid` is a
  last resort, e.g. when a stub replaces a heavy viewer.

## 9. What to test — and what not to

### In scope

- `src/contexts/*` — provider state, the value the context exposes,
  effects (e.g. `AuthContext` listening to supabase auth-state
  changes), the localStorage-vs-context handoff.
- `src/components/**/*.tsx` — every interactive component.
  Headline assertions: keyboard accessibility, ARIA roles match the
  rendered semantics, controlled-input round-trips, disabled-state
  branches.
- `src/app/hooks/*` — `renderHook` from RTL. Cover the loading state,
  the success state, the error state, refetching on dependency change.
- `src/app/lib/mikeApi.ts` — pin the request shape and the error
  mapping. This is the seam where backend changes most often break
  the frontend silently.
- `src/lib/auth-token.ts` — localStorage key contract; race-condition
  semantics if any.

### Out of scope

- Visual regression (Chromatic / Storybook screenshots) — not a unit
  test concern.
- Real network calls to backend, supabase, login.microsoftonline.com,
  or any LLM API.
- Cloudflare Workers / Open Next runtime semantics.
- Server components (see §5).
- PDF/Word/Excel actual rendering — mock the viewers.
- Cross-browser quirks — jsdom is one engine. Real browser issues
  belong in a Playwright suite, not here.

## 10. Coverage targets

Aim for **≥ 80%** line and branch coverage on `src/contexts/**`,
`src/lib/**`, `src/app/hooks/**`, and `src/app/lib/**`. UI components
get a lower floor (**≥ 70%**) because rendering branches with
specific Tailwind variants is often noise, but EVERY interactive
control (button click → handler call, input change → state update)
must be tested.

## 11. Anti-patterns to reject

In addition to the backend prompt's list:

- **Asserting on internal state** via `wrapper.instance().state.x` or
  similar. Test through rendered output and user-visible events.
- **`container.innerHTML.includes("…")`** as an assertion. Use
  `screen.getByText` / `toHaveTextContent`.
- **Snapshot tests of arbitrary JSX.** Snapshots are acceptable only
  for stable, intentionally locked-in trees (the public API of a
  primitive component, perhaps).
- **`waitFor` wrapped around a synchronous expectation.** That
  signals the assertion is racing something; figure out what and
  await it directly.
- **Mocking the component under test.**
- **`expect(button).toBeTruthy()`** — assert that it's in the
  document AND that it has the expected text/role.
- **Tests that pass with `cleanup()` skipped** — `setup.ts` does
  `cleanup()` between tests; tests that rely on residual DOM are
  order-dependent and must be fixed, not papered over.

## 12. Process

1. **Survey first.** Read every file under `src/contexts/`, then
   `src/lib/`, then `src/app/hooks/`, then sample a couple of
   interactive components from `src/components/`. Read
   `src/app/lib/mikeApi.ts` end-to-end. Build a mental map.
2. **Install tooling.** Add the dev dependencies and scripts in §2.
   Create `vitest.config.ts`, `src/test/setup.ts`, `src/test/msw-server.ts`,
   `src/test/render.tsx`.
3. **Smoke-test the harness.** Write one trivial test (e.g. that
   `renderWithProviders(<div>hi</div>)` finds "hi") and run the
   suite once to confirm jsdom + RTL + MSW are wired.
4. **Bottom-up.** Cover `src/lib/auth-token.ts` first (pure, easy),
   then the three contexts, then hooks, then `mikeApi.ts`, then
   high-traffic components. Routes / pages last.
5. **Commit per slice.** One module per commit. `test(frontend/...)`
   conventional-commit prefix.
6. **Update `docs/testing/regime.md` § 6 and §7** after each slice.
7. **Report at the end.** File count, test count, coverage numbers,
   any latent bugs pinned (e.g. mismatches between `mikeApi.ts`'s
   request shape and what the backend tests confirmed it produces).

## 13. Constraints inherited from the project

- **Upstream compatibility** — same as backend. Don't restructure
  components to make them testable unless the alternative is real
  pain.
- **No real secrets** in fixtures.
- **AGPL-3.0** — no third-party test code under incompatible
  licenses.
- **No `NEXT_PUBLIC_*` reintroduction** (see `AGENTS.md`). Tests
  that need runtime config must drive it through `ConfigContext`,
  not by setting `NEXT_PUBLIC_*` env vars.

## 14. Definition of done

Same shape as the backend prompt:

- `npm test` passes with zero skipped tests.
- `npm run test:coverage` clears the §10 thresholds for every
  in-scope directory.
- No test fires a real network request (`onUnhandledRequest: "error"`
  in MSW catches this; a green suite proves it).
- No test reads from real `localStorage` left over from a previous
  run.
- Every interactive component has at least one test that exercises
  a user gesture (click, type, focus, keyboard nav) and asserts the
  resulting state / call / navigation.
- The regime doc is updated.

## 15. Handoff context

This frontend suite is the second half of a two-part testing effort.
The backend suite landed in branch
`claude/typescript-testing-prompt-PyGw2` (merged to main before this
work began) and reached:

- 312 tests across 16 files.
- 100% line coverage on most security-sensitive modules
  (auth providers, downloadTokens, userApiKeys, middleware).
- One latent bug pinned (`routes/user.ts` credit-rolling block is
  unreachable today — see regime doc §6).

Mirror that bar. Substantive negative tests. Real refactor signals.
No Mickey Mouse.
