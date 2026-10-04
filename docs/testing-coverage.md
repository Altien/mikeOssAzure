# Backend test coverage

The Dev fork runs Vitest from `backend/` with pnpm:

```bash
cd backend
pnpm install --frozen-lockfile
pnpm run test:coverage
```

The CI backend job runs this command and `pnpm run build`. Its threshold configuration is `backend/vitest.config.ts`. Treat the coverage report from the current branch as the baseline when changing a floor; the upstream August 2026 figures referred to different storage, authentication, and provider code.

Tests for the private PostgREST and Azure storage adapters should model their actual responses. Tests requiring PostgreSQL use the disposable local PostgreSQL harness; they never require Supabase `auth.users` or a live Azure resource. Focused unit checks can use `pnpm exec vitest run <file>` while developing. A coverage floor change requires a current measured report, not an imported upstream percentage.
