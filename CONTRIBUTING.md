# Contributing to MikeOssAzure

Thank you for considering a contribution. This document covers how to
file issues, where to send security reports, and what we look for in a
pull request.

## Consider contributing upstream first

MikeOssAzure is an AGPL-3.0 fork of the upstream Mike repository. If
your change has **no Azure or Entra dependency** — for example, a bug
fix in document processing, a generic refactor, an upstream-shape
provider boundary — please consider opening it against the original
upstream Mike repository instead of (or as well as) here. Changes that
land upstream benefit every fork and reduce the divergence we have to
maintain on every rebase.

When you decide to send a change upstream, please open a short PR or
issue against this repository letting us know. That way we can:

- track the upstream PR and pull it back into MikeOssAzure once it
  merges (rather than re-implementing the same change here),
- review whether MikeOssAzure also needs an interim fix while the
  upstream PR is in flight,
- give you co-author attribution on the eventual MikeOssAzure commit.

If you are unsure whether a change is upstream-eligible, file an
issue here first and we will help you triage.

## Reporting issues

- **Security** — see [`SECURITY.md`](./SECURITY.md). Do not file public
  GitHub issues for suspected vulnerabilities.
- **Bugs / feature requests** — open a GitHub issue. Include the
  affected version or commit SHA, what you expected to happen, what
  actually happened, and a minimal reproduction.

## Branch and commit shape

- Branch off `main`. Keep PRs focused — one logical change per branch.
- One logical change per commit. Smaller is better, especially for
  anything touching a provider boundary (`backend/src/lib/storage.ts`,
  `backend/src/middleware/auth.ts`, `backend/src/lib/auth/providers/*`,
  `backend/src/lib/llm/index.ts`) so the change can be cherry-picked
  upstream cleanly if upstream wants it.
- Conventional-commit-style prefixes please:
  `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`,
  `chore(scope):`. The body should explain *why*, not *what*.

## Provider boundaries

Changes to the storage / auth / LLM provider boundaries must keep
every existing provider path working with the same env vars and
defaults. Please include an explicit note in the PR description such
as "verified `AUTH_PROVIDER=supabase` still resolves identically" or
"R2-only deployments unaffected".

## Sanitization

This is a public repository. Do not commit:

- Concrete tenant identifiers (Entra tenant IDs, client IDs, scope
  GUIDs).
- Real Azure resource names (resource groups, FQDNs, Key Vault
  names, storage account names).
- Secrets of any kind, including in tests, fixtures, or comments.

Use placeholders such as `<your-resource-group>` or
`00000000-0000-0000-0000-000000000000` instead.

## What "ready for review" looks like

Before requesting review, please make sure:

- `npm run build --prefix backend` passes.
- `npm run build --prefix frontend` passes.
- `npm run lint --prefix frontend` passes.
- Schema migrations (if any) are forward-only, numbered sequentially
  after the existing `0005_postgres_roles.sql`, and have been run
  successfully against the local docker stack
  (`docker-compose.dev.yml`).
- The PR description has a one-paragraph summary, a "test plan"
  section listing what you exercised, and any rollback / risk notes.

## Testing

We are putting together a proper test suite over the coming weeks;
until that lands, contributions should include a written test plan
in the PR description describing how you exercised the change. Once
the suite is in place this section will be updated with concrete
expectations (which suites must pass, where to put new tests, fixture
conventions).

In the meantime, the local docker stack
(`docker-compose.dev.yml` plus `npm run dev --prefix backend` and
`npm run dev --prefix frontend`) is the canonical "does it actually
work" environment. Please exercise the golden path and at least one
failure mode before opening a PR.

## What gets refused without discussion

To keep MikeOssAzure focused, the following kinds of contributions
will be sent back without detailed review:

- Bicep templates, deploy automation, or marketplace packaging — those
  belong in the separate deploy repository, not here.
- Re-introducing hosted-only dependencies that the local-first work
  was specifically designed to remove.
- Anything that bakes a `NEXT_PUBLIC_*` tenant identifier back into
  the frontend bundle. The bundle is intentionally tenant-portable;
  config is read from `/config` at runtime.

## Review and merge

We aim to acknowledge new PRs within five working days. PRs are
squash-merged by default; commit history within a PR is for review
context, not for `main`. Multi-step refactors that genuinely benefit
from preserved per-commit history can ask for a merge commit instead
in the PR description.

## Contact

For anything that does not fit a GitHub issue, contact
**security@altien.com** for security matters, or open a GitHub
discussion for everything else.
