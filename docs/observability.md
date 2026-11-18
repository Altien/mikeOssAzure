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
backend's `build_mode` tag follows it rather than `NODE_ENV`.
`SENTRY_SOURCE_RUN_IS_INSTALL=true` declares a source run in production an
install: with a DSN set it then reports as `self-hosted` with
`build_mode=production`, like the compiled image. Neither bundle contains an
upstream or maintainer DSN. The static web export has no Next.js server or API gateway; API failures are correlated
at the Express `/api` boundary with `X-Request-ID`.

The backend, web app, and Word add-in use an outbound allowlist before events
leave the process. It retains bounded error identity, code location, operation
labels, normalized route, status, and validated request IDs. Request bodies,
headers, cookies, URLs with queries, chat or document text, user identities,
breadcrumbs, replay, attachments, traces, and non-error envelopes are excluded
(the backend can opt in to structured logs and metrics; see
[Structured logs and metrics](#structured-logs-and-metrics)).
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

Limits of whatever sits in front of the API (upstream e6a958d6,
`component=gateway-limit`, warning). Neither is visible from the backend, so
the browser reports them: a `413` that carries none of the backend's own codes
(`stage=payload-too-large`: a reverse proxy's or ingress's request-size cap
refused the body, one issue per route), and an assistant stream that ended
without its `[DONE]` marker (`stage=stream-incomplete`: a proxy or ingress
time limit, or a restart, closed a reply that was still running). The
backend's own size limits answer with a `code` and are not reported.

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

### Repeat budget

Volume policy is separate from `privacyBoundaryIntegration`, which always
rebuilds the outbound allowlist. Pinned fingerprints use their complete
controlled fingerprint and severity; fingerprints containing `{{ default }}`
also use exception type and top frame. The first observation
always passes; repeats send at occurrences 2, 4, 8, … (tagged `occurrence`),
resetting after one quiet hour. The backend SDK and the browser tunnel
(`POST /api/monitoring`) read `SENTRY_MAX_REPEAT_EVENTS_PER_DAY`: a nonnegative
integer caps **repeat** events per day per budget, and `0` keeps only first
observations, severity changes and diagnostic probes. Upstream's hard ceiling
of 50 events a day (at most 25 repeats) applies only to a DSN matching a
built-in Mike project; Dev bakes none, so blank means no daily cap here.
Power-of-two sampling still applies. The add-in gets the power-of-two sampling but no daily cap: Dev bakes
no `REACT_APP_SENTRY_*` settings into the bundle. Budgets are per process,
thread or task pane and are bounded to 1,000 recent keys. The former
`SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE` throttle is retired.

### Structured logs and metrics

Off by default. With `SENTRY_LOGS=on` (and a deployment DSN configured — Dev
bakes none) the backend also sends its structured logs to
[Sentry Logs](https://docs.sentry.io/platforms/javascript/guides/node/logs/)
and its counters to [Sentry's Application Metrics](https://docs.sentry.io/platforms/javascript/guides/node/metrics/),
to whichever project its error events go to. Error events and their budgets
are unaffected. The web app and the Word add-in do not send logs.

The backend's line logger is `backend/src/lib/log.ts` (upstream b625334f):

```ts
import { countMetric, log, logEvent, tpl } from "../lib/log";

log.warn("dbq", "poll failed", error);                    // "[dbq] poll failed" + error printed
log.info(tpl`[dbq] runner started (poll ${ms}ms)`);       // values printed, not sent
logEvent("info", "tool-activity", "counted", { tool, count });
countMetric("tool_activity", count, { kind, tool, outcome });
```

Every call prints exactly as `console.warn` or `console.log` would, so the
line still passes through Dev's console bridge (`lib/logging/consoleBridge.ts`,
errors serialised by `lib/logging/serialize.ts`) into the structured stdout /
Application Insights sink. It sits on top of that bridge and does not replace
it, nor Dev's structured root logger (`lib/logging/root.ts`, imported as
`rootLog` where both are used). What goes to Sentry is narrower:

| Part | Printed | Sent to Sentry |
|---|---|---|
| Scope and message | yes | yes; both must be literals in the source |
| A `tpl` line's values | yes | no; each is sent as `{}` |
| `logEvent` and `countMetric` attributes | yes | only `kind`, `tool`, `outcome` and `count`, each a number, a boolean, or a string shaped like an identifier (letters, digits, `_ . : -`, at most 64 characters) |
| `detail` arguments (errors, paths, objects) | yes | never |

The privacy boundary enforces this again on the way out: it rebuilds each log
and metric from those fields, refuses a body that is not `[scope] message` or
a metric name that is not an identifier, and drops every attribute not named
in `TELEMETRY_ATTRIBUTES` (`sentryPrivacy.ts`, mirrored in
`packages/client`), including the SDK's own (`user.*`, `server.address`,
`sentry.*`) except the environment and release. To send a new attribute, add
its name there in both copies; a shape check alone cannot tell an identifier
from a file name or a key.
`backend/src/__tests__/logContract.test.ts` fails if a scope, message or
metric name is built at run time, or if code calls `Sentry.logger` or
`Sentry.metrics` directly. As with diagnostic labels, never put a client's
words in a scope, a message or a metric name.

At most `SENTRY_MAX_LOGS_PER_DAY` logs and as many metrics (default 5,000
each) leave one process per UTC day; one `[sentry]` warning marks the limit.
Logs and metrics are billed by Sentry separately from errors.

`console.error` is not part of this: it is already filed as an error event.
Warn and info lines that still call `console.warn` or `console.log` directly
(a message with no `[scope]`, or one built from a variable) are printed only.

### Reporting ownership

Capture the original exception at the boundary that knows the operation and
whether recovery failed. A known UI code, HTTP status or `AbortError` name is
not evidence that another owner handled the failure. Expected outcomes are
marked explicitly with `markErrorHandled` at that boundary. The registry means
the reporting decision was made; it does not guarantee delivery to Sentry.
Keep unowned terminal failures visible, including response-body failures after
`fetch` resolves and plain proxy errors without a Mike ownership marker.

Development reporting stays off unless a destination is explicitly configured;
opted-in errors are not filtered using compiler or framework filenames.

Console capture is a fallback. Its primary exception determines identity and
deduplication; contextual errors alongside it cannot hide or relabel it. Prefer
`reportError(original, context)` followed by logging the same object. Preserve
causes, code locations, operation/stage and safe correlation IDs. Tests should
inspect final SDK envelopes for diagnostic usefulness and privacy.

The job runner owns retry/terminal reporting. `NonRetryableJobError` retains a
cause and accepts a terminal `reportLevel`: `error` by default, `warning`, or
`null` only for an outcome the handler has deliberately handled. Quiet outcomes
are registered so a later automatic copy cannot resurrect them.

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

### Consolidated failure handling (2ada45fb)

HTTP error helpers send `reporting_owner: "backend"` only after taking responsibility for a failure; clients propagate that field on the original error, and a status, request ID or recognized UI code alone is insufficient. Dev has no Next.js gateway, so the Express `/api` boundary is the only server owner.

Model failures keep the provider's original cause and whose credential was sent. Rate limits and outages are warnings; unexplained failures and refused deployment credentials are errors. Dev's provider credentials are organisation-managed (Key Vault or environment), so their refusals are deployment-owned and reported; only a pooled member's own key is a user account whose refusal a chat turn may mark handled while it shows the remedy. Background memory jobs and tabular cells keep their reports. Deterministic provider refusals end memory retries; no available model leaves the curator idle. A missing provider key is a safe-to-display "ask an administrator" message, with the Key Vault secret named only in the server log.

A Vercel AI Gateway 403 carrying the gateway's own error is a `chat.provider_rejected` account refusal, classified from the status and body wherever they sit in the cause chain (ff451357). The owner of a personal key sees the gateway's sanitized reason; organisation or deployment keys get a fixed sentence. The turn stays reported (warning for a personal key, error for a shared one) because the reason is relayed, not recognized. A gateway 4xx whose type is outside the reviewed list carries no `provider_error_type` — neither the unreviewed string nor the SDK's catch-all `internal_server_error` stands in for it. A direct provider's or OpenRouter's 403 is unchanged.

Redis listeners cover producer, consumer and worker emitters, and connection outages escalate after 15 minutes. Parser IPC keeps source stacks locally; proven invalid bytes end job retries, while unknown parser and environment failures stay retryable. SDK compatibility notices become local warnings and stage breadcrumbs; SDK deprecations and unrecognized process warnings stay reportable. Missing credential-encryption secrets are `configuration_invalid`, named by their fields at the read/write boundary. When the S3/R2 storage driver's endpoint is unreachable from browsers (loopback, an internal service name, or http under https), the backend warns at boot.
