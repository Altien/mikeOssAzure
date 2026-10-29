# Provider fixture checks in Dev CI

Upstream divergence (sync-log: e436b039): **NOT SUPPORTED** — the retired
Supabase browser E2E workflow, browser auth fixtures, browser boot configuration
and full-stack chat specs remain absent from Dev. Do not re-enable that harness
until its complete local/private-PostgREST/static-export counterpart is
intentionally adopted. No full-stack browser coverage is claimed by this import.

The existing backend CI job runs the source-authored standalone protocol checks:

```bash
node --test e2e/anthropic-stub.check.mjs
```

These three checks use the installed backend AI SDK against a temporary loopback
Anthropic fixture: JSON title completion, streamed text and a document-tool round
trip. They establish only the fixture/SDK protocol boundary. They do not boot the
web app, authenticate a real browser, exercise persistence/storage/extraction, or
prove live-provider behavior. Existing backend/frontend/Word suites and the
separate native desktop local harness retain their existing responsibilities.

For isolated local integration work, `node e2e/anthropic-stub.mjs` listens on
127.0.0.1:4141. An explicitly test-only backend can use
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/v1 and ANTHROPIC_API_KEY=e2e-local-key.
Keep production runtime configuration and administrator-managed credentials
unchanged.
