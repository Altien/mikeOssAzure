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

## System Workflows

System workflows live in the sibling
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository under `assistant-workflows/` and `tabular-review-workflows/`. Put
structured metadata in the YAML frontmatter at the top of `SKILL.md`, put
workflow instructions in the body of `SKILL.md`, and use `table-columns.yaml`
for tabular review columns.

How workflows reach users:

- **Defaults.** Five hardcoded workflows (`DEFAULT_WORKFLOW_IDS` in
  `backend/src/lib/workflowCatalog.ts`) are installed for every user on first
  use, together with their quick-action settings. Changing which workflows are
  defaults means editing that list — nothing in the workflow repository
  controls it.
- **Add-ons.** Every other workflow in the repository ships in the Add-ons
  catalog. Users import an add-on as an independent, editable copy of the
  workflow.
- **Packs.** A directory with a `pack.yaml` groups its child workflow
  directories into a pack shown together in the catalog. `pack.yaml` must list
  exactly the workflow directories that exist under it — the build fails on
  either a listed-but-missing or an unlisted workflow.
- The `metadata.mike-availability` frontmatter key is deprecated and ignored:
  the default/add-on split comes from `DEFAULT_WORKFLOW_IDS`, not from the
  workflow files. Existing files may keep the key; the generator accepts it
  but never emits it.

After changing system workflows, regenerate the app files:

```bash
node scripts/build-workflows.js
```

The generator stamps the `mike-workflows` commit it read into the generated
files (`SYSTEM_WORKFLOWS_SOURCE_COMMIT`), and upstream CI regenerates from that commit
and fails on any drift — so always commit the regenerated files together with
a workflow change.

<!-- Dev fork rule (OSS-6 spec §3.3): the checked-in
     `backend/src/lib/systemWorkflows.ts` is generated content and the runtime
     source of truth. This fork has no dev-only system workflows, so it never
     needs to regenerate: during an upstream sync, resolve conflicts on
     `systemWorkflows.ts` (and `scripts/build-workflows.js`) by taking
     upstream's version. Never hand-edit it. Regenerating locally requires
     cloning `mike-workflows` as a sibling; the generator skips `landing/`
     when that directory is absent. -->


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

## Frontend UI Work

Before writing a new component, check whether one already exists. Look first in
`frontend/src/app/components/ui/` (and `frontend/src/shared/ui/` for anything the
Word add-in also renders), then in the [shadcn/ui](https://ui.shadcn.com)
registry — the project is configured for it in `frontend/components.json`, so
`npx shadcn@latest add <component>` lands a component in the right place with
the right style and tokens. Write a one-off in the feature directory only when
the markup is genuinely specific to that feature; once the same markup shows up
in a second feature file, promote it into `components/ui/` with a test and
replace the copies. Use the documented color, typography, spacing and radius
tokens rather than raw hex values, and keep the accessibility baseline (visible
focus ring, accessible name on icon-only controls, `type="button"`, ARIA state
alongside color). See [docs/design-system.md](docs/design-system.md) for the
tokens, the primitive inventory, and the full baseline.

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

## Migrations

Nothing migrates on boot — several replicas can start against one database,
so applying them is a deliberate step:

```bash
npm run migrate:local --prefix backend   # docker-compose Postgres
npm run migrate:dev   --prefix backend   # any other DATABASE_URL
```

On startup the server compares the migrations in the build against the
`pgmigrations` table and prints the names of any that are unapplied. It only
reports: a schema behind the code otherwise fails later as an unrelated
application error.

## Backend dev logs

`npm run dev --prefix backend` tees everything the server prints — including
stack traces and unhandled rejections — to `backend/.tmp/backend-dev.log`,
so a failed request can be read after the fact instead of being lost to a
scrolled terminal:

```bash
tail -f backend/.tmp/backend-dev.log
```

The file appends across restarts and marks each run with a `===== dev start`
separator; delete it when it gets long. Set `DEV_LOG_FILE` to write
elsewhere, or use `npm run dev:nolog --prefix backend` for the previous
console-only behaviour.

## Testing

<!-- Upstream divergence (sync-log: 15b7b4c): upstream's Testing section also
     lists a Playwright e2e suite, an evals harness, a Supabase-gated stack
     suite and .github CI workflows; dev has none of those, so only the
     applicable commands and policy are kept. -->

```bash
npm test --prefix backend            # backend unit + route integration tests (vitest)
npm test --prefix frontend           # frontend component/hook tests (vitest + jsdom)
```

- New features and bug fixes should come with a test at the lowest layer that
  can catch the regression: unit first, then route-level integration.
- Tests that need a live service or an LLM key are env-gated and skip cleanly
  when the environment is absent — a plain `npm test` should always be green.

## What gets refused without discussion

To keep MikeOssAzure focused, the following kinds of contributions
will be sent back without detailed review:

- Bicep templates, ARM templates, deploy automation, or other
  infrastructure-as-code — those are out of scope for this repository.
  Application-layer changes only.
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
