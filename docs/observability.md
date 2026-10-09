# Error tracking with Sentry

Sentry is optional and disabled until the deployment configures its own DSN.
The backend API reads `sentry-dsn` from Key Vault first and falls back to
`SENTRY_DSN`. The worker thread inherits the initialized backend setting; a
standalone worker reads the same Key Vault secret and fallback. Web and Word
browser bundles use `@sentry/react` and receive public, write-only DSNs from
`GET /config`: `sentry-frontend-dsn` / `sentry-word-dsn` from Key Vault first,
then `SENTRY_FRONTEND_DSN` / `SENTRY_WORD_DSN`. An empty value disables
reporting. Neither bundle contains an upstream or maintainer DSN. The static
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
