# Error tracking with Sentry

Sentry is optional and disabled until the deployment configures its own DSN.
The backend API reads `sentry-dsn` from Key Vault first and falls back to
`SENTRY_DSN`. The worker thread inherits the initialized backend setting; a
standalone worker reads the same Key Vault secret and fallback. Web and Word
browser bundles use `@sentry/react` and receive public, write-only DSNs from
`GET /config`: `sentry-frontend-dsn` / `sentry-word-dsn` from Key Vault first,
then `SENTRY_FRONTEND_DSN` / `SENTRY_WORD_DSN`. An empty value disables
reporting. A development build (the backend run from its TypeScript source,
`tsx watch src/index.ts`; `next dev`; the add-in's webpack dev server) is
likewise off unless a DSN is set on purpose, and `SENTRY_DISABLED=false` does
not change that. When one does report, its `environment` is `development`
instead of the default `self-hosted`; an explicit `SENTRY_ENVIRONMENT` always
wins. The compiled backend image is never a development build, whatever
`NODE_ENV` it runs with; the rule is `backend/src/lib/buildMode.ts`, and the
backend's `build_mode` tag follows it rather than `NODE_ENV`. Neither bundle contains an upstream or maintainer DSN. The static
web export has no Next.js server or API gateway; API failures are correlated
at the Express `/api` boundary with `X-Request-ID`.

The backend, web app, and Word add-in use an outbound allowlist before events
leave the process. It retains bounded error identity, code location, operation
labels, normalized route, status, and validated request IDs. Request bodies,
headers, cookies, URLs with queries, chat or document text, user identities,
breadcrumbs, replay, attachments, traces, and non-error envelopes are excluded.
With SDK v11, every SDK option sets `dataCollection` to collect nothing optional
(no user info, cookies, headers, bodies, URL query parameters, AI inputs or
outputs, stack-frame variables or context lines); the backend also keeps
`maxRequestBodySize: "none"`. Browser Sentry starts only after runtime config
loads; the add-in does the same for its task pane and commands. It is safe for
`/config` to expose a DSN because it only authorizes submission of reports,
not access to stored reports.

Application Insights may also receive local server logs. Operators should
avoid logging raw request paths, provider responses, and secrets there. The
Sentry privacy boundary does not sanitize a separate log sink. The optional
`SENTRY_ENABLE_TEST_ROUTE=true` exposes `/api/observability/sentry-test` for
an authorized deployment diagnostic; leave it disabled ordinarily.

Where Sentry is off, an auth failure's cause does not reach the logs, which say
only "Auth session is unavailable". The passphrase-gated
[health page](upgrade-marketplace.md#health-page) at `/diag` names common causes
directly, such as an expired Entra client secret, and reports whether Application
Insights and Sentry are on. It exists only while `DIAGNOSTICS_HEALTH_TOKEN` is set. The
passphrase is typed into a form, so it is not in a URL for request telemetry or access
logs to record. The page cannot diagnose a revision that fails its startup gates; read
that revision's console logs instead.

This adaptation keeps Entra/local opaque-cookie authentication, private
PostgREST, Azure Blob storage, and static export. The upstream source's
historical [data audit](sentry-data-audit.md) and
[issue review](sentry-issue-review-2026-09-23.md) describe the upstream
installation at the time of review; their default-on claims do not apply to
this Azure fork.

Outage grouping (upstream #541): an unreachable API is one condition, not one
issue per route. The browser sends a fetch `TypeError` as a single
`api-unreachable` event with the pinned fingerprint `api-unreachable` and a
`network_failure_count`, at most once per 60-second window, and nothing while
`navigator.onLine` is false. Worker poll loops (uploads and the `db_jobs`
runner) report the first failure of a class, stay quiet for repeats with a
once-a-minute `console.warn` count, back off, and log recovery. A PostgREST
`PGRST202`/`PGRST204`/`PGRST205` or Postgres `42P01` in a route answers
`503 schema_out_of_date` with fixed text, reported once, plus an operator
`console.warn` naming the numbered migrations. Upstream's Next `/api` gateway
grouping (`upstream-unavailable`) does not apply: the static export has no
gateway.

Playbook import/review lifecycle reports retain bounded stage/job/UUID identifiers only. Rule, finding, source and contract text remain excluded.

Node process warnings are reported as warning events grouped by warning name
and Node diagnostic code. The console bridge drops Node's printed warning line
because the warning object has already been captured through the backend's
request-scoped Sentry reporter. Operators can silence Node warning reports
with --no-warnings or NODE_NO_WARNINGS=1.

### Release identity, source maps and the tunnel

Every runtime tags events with `mike@<version>+<sha12>` (upstream #747,
MIK-62): `/VERSION` is the product version, passed to the image builds as
`MIKE_VERSION`, with the commit as `GIT_SHA`. `SENTRY_RELEASE` overrides it.
A build without them is `mike@0.0.0…` and the backend warns in production.
The backend computes the release from its image environment and `GET /config`
returns it as `sentryRelease`, so the bundled web app reports the same
release. The Word add-in is a separate image, so it bakes
`REACT_APP_MIKE_VERSION`/`REACT_APP_GIT_SHA` at build. The release is build
identity, not tenant data, and the DSNs remain runtime-only. `VERSION` records
the upstream Mike product version this code tracks. Marketplace numbering
stays in `VERSIONS.md`.

Source maps are uploaded only when `deploy.ps1` or
`scripts/release-images.sh` has `SENTRY_ORG`, the projects and a token.
The projects are `SENTRY_PROJECT_FRONTEND` for the web bundle and
`SENTRY_PROJECT_WORD` for the add-in; `release-images.sh` builds only the
web image.
The token is read from Key Vault first (`sentry-auth-token` in the vault named
by `KEY_VAULT_NAME`, or the secret named by `SENTRY_AUTH_TOKEN_SECRET_NAME`),
with `SENTRY_AUTH_TOKEN` as the fallback. `az acr build` has no BuildKit secret
mounts, so the scripts pass the token with `--secret-build-arg`. It is used only
in the build stages: the Word plugin and the web `scripts/upload-sourcemaps.mjs`
upload the maps and then delete them, so no map ships in either image.

The web app's browser SDK posts envelopes to the backend tunnel
`POST /api/monitoring`, not to Sentry directly. Upstream uses a Next
`/monitoring` route handler, which the static export cannot host. The tunnel
answers 204 when `SENTRY_DISABLED=true` or no web DSN is configured. Otherwise
it rewrites the envelope header to the runtime web DSN (`sentry-frontend-dsn`,
then `SENTRY_FRONTEND_DSN`), applies `SENTRY_ENVIRONMENT`/`SENTRY_INSTALL` to
event items, and forwards it, refusing envelopes over 1 MiB. The destination
never comes from the request. `GET /api/monitoring` returns the rule that
applied (`disabled`, `runtime` or `none`), never the DSN.

Not carried from #747: the GHCR `publish-images` workflow, compose image
anchors and image-based db-init. Dev releases through its ACR/marketplace
pipeline.


### Operation and cause identity (46dc4b5c)

Requests and isolated background jobs name their operation; typed AppError failures carry a kind and preserve their real cause; the deepest cause kind wins so wrappers cannot hide it. Diagnostic transport keeps only source-authored diagnostic labels and bounded technical codes/status and scrubbed stacks, never error text, provider bodies, credentials, or document content. Dev keeps its configured telemetry destination, Entra/local opaque sessions, /api/runtime config, canonical claims and revision-aware publication. Retried/optional work retains its existing ownership and fallback policy.

Unknown database job kinds use jobs.dispatch inside the same isolated canonical claim handler. Destructive cleanup remains retry-until-success. withKind preserves an Error already carrying a named cause.


### Source contract for diagnostic identity

- Give errors static class names. Do not derive `Error.name`, class names or
  function names from a customer, document, request or upstream response.
- Write operation, kind, stage, component and job labels in code. A fixed map
  selected by runtime state is fine; interpolating runtime data into a label
  is not. New labels and application error subclasses need no registration.
- Wrap upstream failures with `new AppError("feature.step_failed",
  "Step failed", { cause })`. Preserve the cause for technical classification;
  never copy its prose into diagnostic labels or extras. The message remains
  local and is not treated as safe to transmit merely because it is an AppError.
- `backend/src/__tests__/diagnosticVocabulary.test.ts` parses production
  TypeScript/TSX across all three applications. It rejects common dynamic-name
  and label mistakes. This is a coding contract backed by CI and review, not
  whole-program taint analysis: helper parameters and fixed mappings still
  need review for their origin.
- Real-SDK transport tests cover both install modes, including new unregistered
  labels, dependency-provided names/kinds, cause payloads and automatic captures.

### Client reporting contract

- `describeError`, `userFacingApiError` and the add-in's `userMessage` only
  classify or format a failure. They never capture an event. For an inline
  error, call `reportFault(error, { operation, ...descriptionOptions })`;
  it reports eligible faults and returns the description to render.
- `notifyError` reports and presents an eligible failure. Partial-failure
  notices can report their underlying cause, while their user-facing summary
  stays out of telemetry.
- Typed API wrappers pass their static operation into `apiRequest` before
  the request begins. API 5xx reports are captured immediately with that
  operation; there is no pending-report timer or later screen claim. A
  delayed screen handler cannot change or lose the operation on the event.
- Reporting callers and automatic captures consult the same error registry,
  including a bounded, cycle-safe walk of wrapped causes. Reformatting an
  already-reported failure does not create another event.
- Storage PUT retries report only after the final attempt fails. A recovered
  5xx or network interruption stays quiet; cancellation is not a failure.
  Both clients receive only the terminal error/status from the upload core,
  never the signed URL or file as diagnostic metadata.
- Terminal stream frames use `reporting_owner: "backend"` when the backend
  owns reporting. This does not promise delivery to Sentry. Clients preserve
  that ownership and avoid duplicate reports. A request ID is only for
  correlation: older frames without an ownership field retain client-side
  fallback reporting, even when they have a request ID.

Use `withKind` to wrap a failure only when its cause chain has no application
kind. Domain helpers may build result objects or apply domain-specific policy,
but delegate kind preservation to that helper. `ConversionError` derives its
legacy consumer code from its diagnostic kind; callers do not supply both.

Example (no registry update):

```ts
setOperation("documents.compare");
markStage("load-revisions");
throw new AppError("comparison.source_read_failed", "Could not read revision", { cause });
```


Each API request starts an isolated diagnostic scope before parsing/auth/routing: component=http, operation=http.request, sanitized method/route and generated request ID. Domain setOperation replaces that fallback. Repository code paths and real cause stacks remain; user URLs, query strings, messages and identity remain stripped. Dev mounts this middleware inside createApp without changing /api ingress, rate-limit lanes or runtime configuration.

Row extraction leaves queue retry reporting to the runner; inline streams report at their query boundary. Required export reads propagate storage failures rather than silently omitting files. Optional reads retain their fallback and diagnostic code/kind grouping.

Wrapped client errors share bounded, cycle-safe report ownership across causes. Storage PUT retries report only terminal failures; recovered interruptions and cancellations stay quiet, and signed URLs/files never become diagnostics. Backend-owned terminal frames retain reporting_owner independently of request IDs or delivery.
