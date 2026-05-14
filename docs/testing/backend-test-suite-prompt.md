# Backend TypeScript Test Suite — Authoring Prompt

This document is a **prompt template** for an AI coding agent (e.g. Claude
Code) tasked with building, expanding, or maintaining the backend unit-test
suite for `backend/`. It encodes the conventions, runner choice, and
best-practice constraints the suite must follow. Hand it to the agent
verbatim — or paste it into a slash command — when you want new or revised
backend tests.

A companion document for the frontend lives (or will live) at
`docs/testing/frontend-test-suite-prompt.md`. Keep concerns separated: this
prompt is for **server-side Node/TypeScript code only**.

---

## 1. Goal

Produce a comprehensive, maintainable unit-test suite for the Express +
TypeScript backend in `backend/`. Tests must be fast, deterministic, and
isolated from real network, real databases, real cloud services, and real
LLM providers. Coverage is a means, not the goal — every test must assert
behaviour a future developer could plausibly break.

## 2. Runner & Tooling — Vitest

Use **Vitest** as the test runner. Do not introduce Jest, Mocha, or
`node:test`. Rationale:

- Native TypeScript and ESM/CJS interop without `ts-jest` or babel config.
- Jest-compatible API (`describe`, `it`, `expect`, `vi.fn`, `vi.mock`) so
  patterns transfer easily.
- Fast (esbuild-powered) — important because the suite will be run on
  every commit.
- Built-in coverage via `@vitest/coverage-v8`.
- `vite-tsconfig-paths` resolves the `@/*` alias defined in
  `backend/tsconfig.json` with no additional Jest moduleNameMapper hacks.

### Required dev dependencies

Add to `backend/package.json` as `devDependencies`:

- `vitest`
- `@vitest/coverage-v8`
- `vite-tsconfig-paths`
- `supertest` and `@types/supertest` — for HTTP-level route tests against
  the Express app without binding a port.

### Scripts

Add to `backend/package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

### Config

Create `backend/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/test/**",
        "src/scripts/**",
        "src/index.ts",
      ],
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
```

Do **not** set `globals: true`. Import `describe`, `it`, `expect`, `vi`
explicitly so tests are greppable and IDE navigation is unambiguous.

### Test file location

Co-locate tests with source: `src/lib/foo.ts` → `src/lib/foo.test.ts`.
Integration-style tests that exercise an Express route through `supertest`
go under `src/routes/<name>.test.ts`.

## 3. Conventions

### Naming

- File suffix: `.test.ts` for unit tests, `.spec.ts` reserved for
  integration tests that boot the Express app.
- `describe` block names a unit (function, class, or route).
- `it` (preferred over `test`) statements read as English sentences:
  `it("rejects requests without a tenant header", ...)`.

### Structure: Arrange / Act / Assert

Each test follows AAA with blank-line separation:

```ts
it("returns 404 when the document is missing", async () => {
  // Arrange
  const repo = { findById: vi.fn().mockResolvedValue(null) };

  // Act
  const res = await getDocument(repo, "missing-id");

  // Assert
  expect(res.status).toBe(404);
});
```

### Determinism

- Never call `Date.now()`, `new Date()`, `Math.random()`, or `crypto`
  without freezing them. Use `vi.useFakeTimers()` and
  `vi.setSystemTime(new Date("2025-01-01T00:00:00Z"))` in the relevant
  `beforeEach`, then `vi.useRealTimers()` after.
- No `await new Promise(r => setTimeout(r, …))` waits.
- No reliance on filesystem state outside `os.tmpdir()` paths that the
  test itself creates and cleans up.

### Isolation

- One assertion concept per test. Multiple `expect` calls are fine when
  they verify a single behaviour (e.g. status + body shape).
- Tests must pass when run in any order and in parallel. If a test
  mutates a module-level singleton (e.g. a cached config), reset it in
  `afterEach`.

## 4. What to test — and what not to

### In scope

- `src/lib/**` — pure helpers, parsers, validators, token signing, LLM
  request shapers, access-control logic, workflow definitions.
- `src/middleware/**` — every branch (auth ok / missing / expired,
  tenant present / absent / mismatched, role allowed / denied).
- `src/routes/**` — for each route, cover:
  - happy path (200/201 with expected body shape),
  - input validation failures (400),
  - auth/role failures (401/403),
  - downstream errors (500 / mapped error codes),
  - tenant-scoping (a user from tenant A cannot read tenant B data).
- Migration runner logic in `src/scripts/runMigrations.ts` should be
  tested via a fake pg client; the SQL files themselves are out of scope
  for unit tests.

### Out of scope for this suite

- Real network calls to Anthropic, OpenAI, Google GenAI, Resend, S3, or
  Azure services. Mock the SDK clients.
- A live Postgres instance. Mock the `pg` `Pool`/`Client` interface.
- LibreOffice / `libreoffice-convert` binary invocation. Mock the
  module.
- End-to-end browser flows. Those belong to the frontend suite or a
  separate e2e harness.

## 5. Mocking strategy

### Prefer dependency injection over `vi.mock`

When possible, refactor the unit under test to accept its collaborators
(DB pool, S3 client, LLM client, clock) as parameters or via a small
factory. Inject fakes in tests. This is faster, type-safe, and avoids
brittle module-mock hoisting.

If a module reaches for a singleton (e.g. `getPgPool()` or
`getAnthropicClient()`), wrap that reach in a thin function that can be
overridden, or use `vi.mock("@/lib/pg", () => ({ getPgPool: vi.fn() }))`
at the top of the test file. Always re-export the type so the mock stays
typed.

### Per-SDK guidance

- **`pg` (`Pool`/`Client`)**: build a tiny fake exposing `query` and
  `connect`. Have `query` return `{ rows, rowCount }` objects.
- **`@anthropic-ai/sdk`, `openai`, `@google/genai`**: mock the constructor
  or the relevant method (`messages.create`, `chat.completions.create`).
  Return canned response objects. Never call the real network.
- **`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`**: mock the
  `send` method and `getSignedUrl` function.
- **`@azure/storage-blob`, `@azure/identity`, `@azure/keyvault-secrets`**:
  mock the client classes; assert on the arguments passed to upload /
  download / get-secret calls.
- **`resend`**: mock `emails.send`; assert recipient, subject, and that
  it is not called when feature-flagged off.
- **`fs` / `fs/promises`**: prefer real reads/writes to `os.tmpdir()`
  with cleanup in `afterEach`. Mock only when the path under test
  genuinely should never touch disk.

### Express route tests

Use `supertest` against the exported app (extract `app` from
`src/index.ts` into a `src/app.ts` if it isn't already, so tests import
the app without `app.listen` being called). Inject mocked middleware
state via request headers or by stubbing the auth middleware.

```ts
import request from "supertest";
import { buildApp } from "@/app";

const app = buildApp({ db: fakeDb, llm: fakeLlm });
const res = await request(app)
  .get("/documents/abc")
  .set("Authorization", "Bearer test-token");
expect(res.status).toBe(200);
```

## 6. Coverage targets

Aim for **≥ 80%** line and branch coverage on `src/lib/**`,
`src/middleware/**`, and `src/routes/**`. Do not chase 100% — generated
SQL templates, defensive `throw new Error("unreachable")` branches, and
process-bootstrap code in `src/index.ts` are exempt (already excluded in
the Vitest config above).

Coverage is a floor, not a ceiling. A 95%-covered module with no
assertions on its branches is worse than an 80%-covered module that
verifies every error path.

## 7. Anti-patterns to reject

The agent must refuse to write — or should refactor away — tests that
exhibit any of the following:

- **Snapshot tests for arbitrary JSON or HTML.** Snapshots are acceptable
  only for stable, intentionally locked-in shapes (e.g. a public API
  contract). Otherwise they rot into rubber stamps.
- **Asserting on log output.** Logs are not behaviour.
- **Tests that re-implement the function under test in the test body.**
  If the test reproduces the production algorithm to compute the
  expected value, it is not testing anything.
- **Mocking the function you are testing.** Test the real implementation;
  mock only its collaborators.
- **`expect(...).toBeTruthy()` / `toBeDefined()` as a primary assertion.**
  Assert the exact shape or value. Truthy assertions hide regressions.
- **Catch-and-ignore in tests.** A thrown error must either be the
  asserted outcome (`await expect(fn()).rejects.toThrow(...)`) or fail
  the test.
- **Network or DB calls.** Any test that opens a TCP socket to a real
  host must be removed or moved to a separate integration suite.
- **Time-dependent flakes.** No `setTimeout`-based polling. Use fake
  timers.

## 8. Process the agent should follow

1. **Survey first.** Read `backend/src/index.ts`, every file in
   `backend/src/lib/`, `backend/src/middleware/`, and
   `backend/src/routes/`. Build a mental map before writing any tests.
2. **Install tooling.** Add the dependencies and scripts in Section 2.
   Create `vitest.config.ts` and `src/test/setup.ts` (the latter can be
   empty initially, or set `process.env.NODE_ENV = "test"` and stub
   noisy globals).
3. **Extract `app.ts` if needed.** If `src/index.ts` builds the Express
   app and calls `listen()` in the same module, split it so tests can
   import the app without binding a port.
4. **Write tests bottom-up.** Start with `src/lib` (pure functions),
   then `src/middleware`, then `src/routes`. Run `npm test` after each
   file; do not let the suite go red for more than one commit.
5. **Commit in small, reviewable chunks.** One module's tests per
   commit. Commit messages: `test(lib/access): cover tenant scoping
   branches`. Do not mix test additions with production refactors in
   the same commit unless the refactor is a trivial extraction needed
   to make the code testable (e.g. splitting `index.ts`).
6. **Report at the end.** Summarise: files touched, total test count,
   coverage percentages (line / branch / function), and a list of any
   production-code refactors made for testability.

## 9. Constraints inherited from the project

- **Upstream compatibility** (see `AGENTS.md`). Keep production-code
  changes minimal and shaped like the upstream repo. Prefer adding test
  files over restructuring source. When a refactor is unavoidable for
  testability, document it in the commit message.
- **No real secrets.** Test fixtures must use placeholder values. Never
  commit a `.env` of any kind; if a test needs env vars, set them in
  the test file or `src/test/setup.ts`.
- **AGPL-3.0.** Do not paste in third-party test code under
  incompatible licenses.

## 10. Definition of done

A round of test-suite work is complete when:

- `npm test` passes locally with zero skipped tests (unless a skip is
  paired with a TODO and a tracking issue link).
- `npm run test:coverage` reports at or above the Section 6 thresholds
  for each in-scope directory.
- No test makes a real network, DB, or filesystem call outside
  `os.tmpdir()`.
- Every route file under `src/routes/` has a corresponding `.test.ts`
  covering at minimum the five route cases listed in Section 4.
- CI (if configured) is green.
- The summary report from Section 8 step 6 has been produced.
