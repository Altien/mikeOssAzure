# Test depth: mutation and SSE load

`backend/stryker.config.json` describes a mutation harness for security-sensitive modules. It is not a merge gate: the current Stryker/Vitest 5 combination fails to collect per-mutant results reliably. Do not interpret its zero score as a measured test-quality regression. Once the runner supports Vitest 5, verify a real score before raising its threshold or adding a CI gate.

The SSE load harness is an on-demand tool, not a CI check. It requires a disposable non-production deployment and an authenticated test identity. The Dev fork uses Entra/local admission and HttpOnly sessions, private PostgreSQL/PostgREST, and provider credentials from Key Vault, so an upstream Supabase bearer-token recipe does not apply. Use the harness only with the deployment's supported authentication flow and test resources.

Routine CI is defined in `.github/workflows/ci.yml`. It installs the three independent pnpm trees, runs backend and frontend checks, builds the static frontend and component catalog, and packages the Word add-in. These commands must be allowed to fail visibly; an unavailable tool should not be represented as a passing gate.
