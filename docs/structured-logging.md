# Structured logging and per-tenant debug

Status: implemented (`backend/src/lib/logging/`, migration
`0201_tenant_debug_logging.sql`; 0199 and 0200 belong to other PRs).

## Purpose

Today every backend log line is free text written with `console.*`. In Azure
Container Apps those lines land in Log Analytics (`ContainerAppConsoleLogs_CL`,
column `Log_s`) as opaque strings, so an operator cannot ask "everything that
happened to tenant X between 10:00 and 10:20" or "every model step of chat Y".
When a customer reports a failure, the useful detail (model step, finish reason,
tool outcome, lease loss) is not logged at all.

This design makes every backend log line one JSON record that carries tenant,
user and chat/run/request/job ids, and adds a small set of debug events that are
emitted only for a tenant whose operator-set debug switch is on and unexpired.

It supersedes the pino proposal in
`docs/issues/azure-migration/031-comprehensive-logging.md` for the server side.
No logging dependency is added; the logger is a few hundred lines in `lib/logging/`.

## Decisions (settled by the product owner)

1. Every backend log line is one structured JSON record with tenant id, user id,
   and chat/run/request ids where known. Users appear only as user IDs, never
   name or email. No prompt, answer or document content is logged at any level.
2. Backend code depends on an `ILogger` interface. The Azure implementation,
   `AzureConsoleLogger`, writes one JSON line per record to stdout/stderr. It and
   its dependencies (sink, clock, debug gate) are built once at each composition
   root. Tests inject an in-memory sink and a fake clock.
3. `ContextLight` is a small immutable object carrying tenant and user, plus
   optional chat, run, request and job ids. It reaches backend code ambiently
   where AsyncLocalStorage survives and is passed explicitly where it does not.
4. The ~290 existing `console.*` calls in ~100 files are not rewritten. A bridge
   installed only at the composition roots routes them into the `ILogger` with
   the ambient `ContextLight`. The 77 test files that spy on `console` are
   unaffected because tests never install the bridge.
5. Debug records are emitted only for a tenant whose switch is on and unexpired.
   Default duration 2 hours, hard maximum 24 hours, expiry enforced by Mike. Only
   the control plane sets or clears it, through new `control_plane` functions.
   No customer UI.
6. A first set of about 20 debug events at the points that explain real failures
   (listed below with anchors).

## Design choices made here

- **ContextLight is a projection, not a third tenant store.** `lib/tenantContext.ts`
  already holds `{ tenantId, userId, roles, pooled, readOnly, userEmail }` in an
  AsyncLocalStorage opened by `middleware/auth.ts:151` / `:171` and
  `middleware/tenantAccess.ts:137` for requests, and by `runWithJobTenant` for
  jobs. `lib/requestContext.ts` holds the request id (opened in `app.ts:283`).
  `currentContextLight()` reads both and adds one small *overlay* store for the
  fields neither knows (chat, run, job ids). `userEmail`, `roles` and the flags
  are never copied. The overlay grants no database authority: entering a log
  context never calls `runWithTenant`, so tenancy for RLS still comes only from
  the validated identity or a durable job row.
- **Precedence.** For a record: explicit fields bound with `logger.with(ctx)`
  win; then the tenant store (authoritative for `tenantId`/`userId`); then the
  overlay; then the request-id store.
- **Logger access is a root accessor.** `setRootLogger()` is called once per
  composition root; code calls `log()` (ambient-bound) or
  `log().with(ctx)`. Threading a logger argument through every service would be
  the same upstream divergence `tenantContext.ts` avoided. Before installation
  (and in every test that does not opt in) the root logger is a `NullLogger`, so
  new debug calls never reach `console` and never disturb console spies.
- **Process start/shutdown are `info`, not `debug`.** They have no tenant, so a
  per-tenant gate would suppress them permanently. They are low volume.
- **Debug switch lives on `public.tenants.debug_log_until`** and is read by one
  poll per process every 30 s, not per log line.
- **The bridge writes through the console methods it replaced.** Application
  Insights (`telemetry.ts`, `setAutoCollectConsole`) patches console at import,
  before the bridge; Sentry's `captureConsoleIntegration` patches `console.error`
  inside `initSentry`, after the bridge. Writing through the captured originals
  keeps App Insights capture working, and Sentry still receives the raw
  arguments (it wraps the bridge), so its object-identity de-duplication in
  `processLifecycle.ts` / `sentry.ts` is unchanged.
- **`devLog` (`lib/log.ts`) stays production-silent.** It logs request/response
  shapes and must not be promoted to debug level.

## Architecture

```
composition root (index.ts / worker.ts / workerThread.ts)
  └─ installStructuredLogging({ proc })        lib/logging/install.ts
       ├─ AzureConsoleLogger(sink, clock, debugGate, format)
       ├─ setRootLogger(logger)
       └─ installConsoleBridge(console, logger) (captures originals → sink)
  └─ later in start(): debugSwitches.start(readTenantDebugSwitches)

call site:  log().debug("llm.step.finish", {...})   → ambient ContextLight
            runLog = log().with({ runId })           → explicit, kept on the run
console.warn("[dbq] ...", x)  → bridge → logger.warn(msg, args, src:"console")
```

### Files under `backend/src/lib/logging/`

| File | Content |
|---|---|
| `types.ts` | `LogLevel`, `ILogger`, `LogSink`, `Clock`, `DebugGate`, `LogRecord` |
| `contextLight.ts` | `ContextLight`, `currentContextLight`, `withLogContext`, `bindLogContext`, `runWithContextLight` |
| `debugEvents.ts` | `DebugEventMap` (the reviewed allow-list) and `sanitizeDebugFields` |
| `serialize.ts` | JSON-safe value/error serialisation, redaction, size caps |
| `azureConsoleLogger.ts` | `AzureConsoleLogger`, `NullLogger`, `MemorySink` (exported for tests) |
| `root.ts` | `setRootLogger`, `log()`, `resetRootLoggerForTests` |
| `consoleBridge.ts` | `installConsoleBridge(target, logger)` returning `uninstall()` |
| `tenantDebugSwitches.ts` | `TenantDebugSwitches` cache/poller (no DB import) |
| `tenantDebugStore.ts` | `readTenantDebugSwitches()` using `createPlatformSupabase()` |
| `install.ts` | `installStructuredLogging()` used by the three roots |
| `__tests__/*.test.ts` | unit tests (see Test plan) |

`lib/logging` imports only `lib/` (`tenantContext`, `requestContext`, `safeError`,
`supabase`), so `architecture.test.ts` rule 1 holds.

## TypeScript sketches (signatures only)

```ts
// types.ts
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Clock { now(): number }                 // epoch ms
export interface LogSink { write(level: LogLevel, line: string): void }
export interface DebugGate { isOn(tenantId: string | undefined): boolean }
export type LogFields = Readonly<Record<string, unknown>>;

export interface ILogger {
  debug<E extends DebugEventName>(event: E, fields: DebugEventMap[E]): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields, err?: unknown): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
  /** Bind context explicitly; bound fields win over ambient ones. */
  with(ctx: Partial<ContextLight>): ILogger;
  /** For gating expensive field assembly; same answer debug() would use. */
  debugEnabled(): boolean;
  /** Bridge entry: already-positional console args, level from the method. */
  console(level: LogLevel, args: readonly unknown[]): void;
}

// contextLight.ts
export interface ContextLight {
  readonly tenantId?: string; readonly userId?: string; readonly requestId?: string;
  readonly chatId?: string;   readonly runId?: string;  readonly jobId?: string;
}
export function currentContextLight(): ContextLight;                 // frozen
export function withLogContext<T>(extra: Partial<ContextLight>, fn: () => T): T;  // overlay.run
export function bindLogContext(extra: Partial<ContextLight>): void;  // overlay.enterWith, see below
export function runWithContextLight<T>(ctx: ContextLight, fn: () => T): T; // explicit hand-off

// azureConsoleLogger.ts
export class AzureConsoleLogger implements ILogger {
  constructor(deps: { sink: LogSink; clock: Clock; debugGate: DebugGate;
    proc: "api" | "worker" | "worker-thread"; format?: "json" | "text";
    bound?: Partial<ContextLight> });
}
export class NullLogger implements ILogger {}
export class MemorySink implements LogSink { readonly lines: string[]; records(): LogRecord[] }

// root.ts
export function setRootLogger(logger: ILogger): void;
export function log(): ILogger;            // root logger; ambient context read per record
export function resetRootLoggerForTests(): void;

// consoleBridge.ts
export function installConsoleBridge(target: Console, logger: ILogger): () => void;

// tenantDebugSwitches.ts
export type DebugSwitchRow = { tenantId: string; until: Date };
export class TenantDebugSwitches implements DebugGate {
  constructor(deps: { clock: Clock; refreshMs?: number /* 30_000 */;
    onChange?: (tenantId: string, until: Date | null) => void; onError?: (err: unknown) => void });
  isOn(tenantId: string | undefined): boolean;
  refresh(read: () => Promise<readonly DebugSwitchRow[]>): Promise<void>;
  start(read: () => Promise<readonly DebugSwitchRow[]>): void;  // immediate refresh + unref'd interval
  stop(): void;
}

// tenantDebugStore.ts
export function readTenantDebugSwitches(): Promise<readonly DebugSwitchRow[]>;

// install.ts
export function installStructuredLogging(opts: { proc: "api" | "worker" | "worker-thread";
  target?: Console; env?: NodeJS.ProcessEnv }):   // target/env: test seams
  { logger: ILogger; debugSwitches: TenantDebugSwitches; uninstall(): void };
```

`bindLogContext` uses `AsyncLocalStorage.enterWith` on the overlay store only. It
exists so the four turn routes can add `chatId`/`runId` with one line after the
claim instead of re-indenting several hundred lines of route body (upstream merge
cost). It affects the rest of the calling async function and everything it
awaits or schedules. Use `withLogContext` everywhere a wrapper is cheap.

## Record format

One line per record, `JSON.stringify` of:

| Field | Type | Notes |
|---|---|---|
| `ts` | string | `new Date(clock.now()).toISOString()` (UTC, ms) |
| `level` | `debug`/`info`/`warn`/`error` | |
| `msg` | string | info/warn/error message; for bridged calls the first string argument |
| `event` | string | debug event name (`llm.step.finish`); absent otherwise |
| `proc` | string | `api`, `worker`, `worker-thread` |
| `tenantId`, `userId`, `requestId`, `chatId`, `runId`, `jobId` | string | omitted when unknown (never `null`) |
| `data` | object | debug fields, or info/warn/error fields |
| `args` | array | bridged console arguments after the first string (the first `Error` argument moves to `err`) |
| `err` | object | `{ name, message, code?, stack?, cause?, errors? }` |
| `src` | `"console"` | present only on bridged records |
| `truncated` | `true` | present only when size caps applied |

Serialisation rules (`serialize.ts`):

- Strings in `msg`, `args`, `data` (non-debug) and `err.message`/`err.stack` pass
  through `redactSensitiveText` (`lib/safeError.ts`) and are capped at 2,000
  characters. This is no more content than today's console lines carry.
- Error objects (anywhere): `name`, `message`, string/number `code`, `stack`
  capped at 4,000 characters, one level of `cause`. AggregateError lists at most
  5 inner errors.
- Objects: depth ≤ 4, arrays ≤ 20 items, `bigint` → string, circular → `"[circular]"`,
  functions/symbols dropped, `Buffer`/typed arrays → `"[binary N bytes]"`.
- Keys named `content`, `text`, `prompt`, `messages`, `body`, `answer`,
  `document`, `email`, `userEmail`, `authorization`, `password`, `token` are
  replaced with `"[redacted]"` in `data`/`args` (case-insensitive).
- Whole line capped at **16,000 bytes**. containerd splits longer lines into
  partial records, which breaks `parse_json`. Over the cap: drop `args`, then
  `data`, then trim `err.stack`, then `msg`, then `err.cause`, then `err`; set
  `truncated: true`.
- Levels `debug`/`info` go to stdout; `warn`/`error` to stderr (same streams as
  `console.log`/`console.warn` today; `Stream_s` in Log Analytics).
- `format: "text"` (selected by `LOG_FORMAT=text`; default `json` in production
  and `text` otherwise) prints `ts level [tenant/user] msg {data}` for local dev.
  Both formats share serialisation and redaction.
- Serialisation never throws: on any internal failure the bridge falls back to
  calling the original console method with the raw arguments, and
  `debug`/`info`/`warn`/`error` drop the record.

Example:

```json
{"ts":"2026-11-16T10:02:11.481Z","level":"debug","event":"llm.step.finish","proc":"api","tenantId":"contoso","userId":"3f6c…","requestId":"b1e…","chatId":"9a2…","runId":"77d…","data":{"model":"claude-sonnet-4-5","step":2,"inputTokens":18233,"outputTokens":912,"finishReason":"tool-calls"}}
```

## Redaction rule for debug events (enforced in code)

1. `debug()` accepts only names in `DebugEventMap` and their typed field object.
   Field types are `number | boolean | DebugToken | null | undefined`, where
   `DebugToken` is `string`. Adding an event or field means editing
   `debugEvents.ts`, which is the review point.
2. At runtime every string value must match `^[A-Za-z0-9._:/@+=-]{0,128}$`
   (ids, model names, tool names, finish reasons, error categories). Anything
   else becomes `"[redacted]"`. Prose, sentences and file names contain spaces
   or other characters and cannot pass. Arrays and objects are rejected
   (`"[redacted]"`); use counts instead.
3. A unit test parses `debugEvents.ts` and fails on field names matching
   `/content|text|prompt|message|body|answer|query|arg|input$|output$|title|name$|file|snippet|email/i`,
   except the explicit allow-list `toolName`, `model`, `inputTokens`,
   `outputTokens`, `errorCategory`. (Tool names are static identifiers.)
4. Failures in debug events carry `errorCategory` from `safeError(err).category`
   and, where available, `providerFailureKind`/HTTP status — never `err.message`.

## Debug switch

### Storage and SQL (migration `backend/migrations/0201_tenant_debug_logging.sql`)

```sql
alter table public.tenants add column debug_log_until timestamptz;

create function public.cp_set_tenant_debug(p_tenant_id text, p_minutes integer default 120)
returns timestamptz language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_until timestamptz;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Debug duration must be 1 to 1440 minutes';
  end if;
  update public.tenants set debug_log_until = now() + make_interval(mins => p_minutes)
    where tenant_id = p_tenant_id returning debug_log_until into v_until;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
  return v_until;
end $$;

create function public.cp_clear_tenant_debug(p_tenant_id text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  update public.tenants set debug_log_until = null where tenant_id = p_tenant_id;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
end $$;
```

Then, following `0198_named_microsoft_members.sql` exactly:

- Owner to `service_role` inside the `grant create … / revoke create` block.
- `revoke all on function … from public, web_anon, authenticated, tenant_app, control_plane;`
  `grant execute on function public.cp_set_tenant_debug(text,integer), public.cp_clear_tenant_debug(text) to service_role, control_plane;`
- Extend `app.tenant_rls_gaps()` by replacing `'cp_add_member',` with
  `'cp_set_tenant_debug', 'cp_clear_tenant_debug', 'cp_add_member',` (both
  platform lists; `replace` changes every occurrence).
- Extend `app.control_plane_gaps()` by replacing the **first** array element
  `'public.cp_upsert_tenant(text,text,text,text)'::regprocedure,` with the two
  new regprocedures followed by it. Do not anchor on the array's last element as
  0198 did: an open PR (0199/0200) that adds a function would move it.
- In both blocks compare the new definition with the old and
  `raise exception 'anchor not found'` if unchanged.
- Final gate block (`tenant_rls_gaps() union all control_plane_gaps()` must be
  empty) and `notify pgrst, 'reload schema';`.
- No `begin`/`commit` (the runner wraps the file). No RLS change: `tenants`
  keeps its existing policy, the new column is read only by the platform role,
  and `control_plane` gets no table privilege.

Any tenant status is accepted, so debug can be used while diagnosing a suspended
or offboarding tenant (e.g. a stuck purge). `updated_at` is not touched: this is
not tenant metadata. Calling `cp_set_tenant_debug` again extends or shortens from
now (it is "on for N minutes from now", not additive).

### Protocol contract (for the control plane)

| Function | Returns | Behaviour |
|---|---|---|
| `cp_set_tenant_debug(p_tenant_id text, p_minutes integer default 120)` | `timestamptz` (the end time) | Turns debug logging on for the tenant until `now() + p_minutes`. 22023 if `p_minutes` is null or outside 1–1440; 23503 for an unknown tenant. |
| `cp_clear_tenant_debug(p_tenant_id text)` | `void` | Turns it off. 23503 for an unknown tenant. Idempotent. |

Update `docs/multi-tenant/control-plane-contract.md`: "fourteen signatures" →
"sixteen", add both rows, and note that `cp_set_tenant_debug` is the one function
that returns a value. Effect is visible within 30 s (poll interval), on every
replica and worker. `scripts/multi-tenant/control-plane.mjs` is not changed.

### Reading it in Mike (`TenantDebugSwitches`)

- `readTenantDebugSwitches()`:
  `createPlatformSupabase().from("tenants").select("tenant_id, debug_log_until").gt("debug_log_until", nowIso).abortSignal(AbortSignal.timeout(5_000))`.
  Cross-tenant by design, like `jobs/maintenance.ts:53`.
- `refresh()` replaces the whole map `tenantId → untilMs`, clamping each value to
  `min(until, clock.now() + 24h)` so a hand-edited row cannot exceed the maximum.
  It records `lastSuccessAt`.
- `isOn(tenantId)` is synchronous: `false` if no tenant, no entry, or
  `clock.now() >= until`, or `clock.now() - lastSuccessAt > 3 * refreshMs`
  (a hung or failing poll). Expiry is therefore exact to the millisecond even
  between polls; enabling and early clearing take up to one interval.
- On read failure: clear the map (fail closed), call `onError` once per failure
  streak (the root wires this to a single `warn` record), never throw.
- `onChange` fires when a tenant's effective end changes since it was last
  reported (on, extended, cleared, expired, or cleared by a failed read); the
  root logs an `info` record `logging.debug_switch` with `tenantId` and
  `data.until` (null when off) so Log Analytics shows when debug started and
  stopped. An expiry is reported at the next poll.
- One poller per JS isolate: the API main thread, each worker thread, and the
  standalone worker. That is a handful of small queries per replica per
  30 s over a table with one row per tenant.
- Before `start()` (early boot) every tenant is off.

## Where it is wired

New files: everything in `lib/logging/` above, the migration, its postgres test,
and this doc.

| Existing file | Change | Why |
|---|---|---|
| `src/index.ts` | After `installProcessGuards()` (line 7): `const logging = installStructuredLogging({ proc: "api" });`. In `start()` after `ensureInstallTenant` (line 92): `logging.debugSwitches.start(readTenantDebugSwitches)`. `log().info("process.start", { port, workersMode })` beside line 115; in `shutdown()` `log().info("process.shutdown", { signal })` at entry and `debugSwitches.stop()` before exit. Keep the existing console lines. | Composition root |
| `src/worker.ts` | Same, `proc: "worker"`, start the poller after `startAllWorkers()` resolves (line 30), stop it in `shutdown()` (line 39). | Composition root |
| `src/workerThread.ts` | Same, `proc: "worker-thread"`, include `role` in `process.start`; start after `startAllWorkers` (line 19). | Composition root (own module cache) |
| `src/lib/dbq/runner.ts` | In `processClaimedJob` (line ~580) wrap `runClaimedJob(...)` in `withLogContext({ jobId: job.id }, …)`. Debug events at :237/:241/:278. | Job dequeue context |
| `src/modules/uploads/uploads.processing.ts` | `withLogContext({ jobId })` inside the `runWithJobTenant` at :847; events at :642/:651/:658/:665. | Upload jobs |
| `src/workers/conversion.transport.ts` | `withLogContext({ jobId: job.id })` inside `runWithJobTenant` at :28. | BullMQ jobs |
| `src/lib/streamRuns.ts` | In `startStreamRun` capture `runLog = log().with({ ...currentContextLight(), runId: args.id, userId: args.userId })` on the run record; use it for all run events (timers and heartbeat then log with the right ids even if ambient is lost). Events at :310, :332, :378, :388, :484, :443. Give `ownerLost` a `cause` argument (`"advertise_invalid" \| "advertise_failed" \| "renew_lost" \| "renew_failed"`). | Explicit hand-off for long-lived runs |
| `src/lib/streamRunCluster.ts` | In `dispatch` (:300–311) wrap `serve` in `withLogContext({ runId })` when `message.data.id` is a string; event `relay.dispatch` (op, ok). Event `streamrun.claim` in `claim()` (:339/:345). | Relay has no request context |
| `src/lib/assistantTurnRuns.ts` | `turn.claim` debug event at :142 (surface, chatId, runId, claimed). | One place for 4 surfaces |
| `src/modules/chat/chat.routes.ts` (:630), `project-chat/projectChat.routes.ts` (:176), `word-chat/wordChat.routes.ts` (:745), `tabular/tabular.routes.ts` (:1063, and :492 for generation) | One line after a successful claim: `bindLogContext({ chatId, runId: run.id })` (generation: `runId` only). | Chat/run ids on every later line of the turn, including bridged console lines |
| `src/lib/llm/aiSdk.ts` | Events at :689, :847, :911, :926, :893, and `llm.context_fit` in `prepareStep` after `fitMessagesToBudget` when it changed the messages. | Model calls/steps, compaction decisions |
| `src/lib/llm/providerDeadlines.ts` | Event at :24. | Stall diagnosis |
| `src/lib/llm/lengthContinuation.ts` | Event at :220. | Continuation decisions |
| `src/modules/chat/engine/tools/toolDispatcher.ts` | Record `startedAt` per `tc.id` at the top of the loop (:591); after the loop emit one `tool.call` per call with duration = next start (or loop end) − start and outcome from the matching `toolResults` entry (`error` present → `error`). Events `doc.edit` (:2031) and `doc.generate` (:2487). | Tool calls without re-indenting the 2,000-line loop |
| `src/modules/chat/engine/tools/delegateTools.ts` | Events at :617 and :686. | Delegates |
| `src/modules/documents/documents.conversion.ts` | Events at :31 and :47. | Conversion |
| `docs/multi-tenant/control-plane-contract.md` | Two rows, count, return-type note. | Protocol |
| `docs/backend-architecture.md` | One paragraph under "The shared kernel" pointing here. | Discoverability |

The composition roots import `install.ts` after `./telemetry` and
`./lib/processGuards` (AGENTS.md init-order rule). `install.ts` must not import
`lib/supabase`; `tenantDebugStore.ts` does, and is imported normally.

Not touched: `workerRuntime.ts` (imported by tests; installing there would put
the bridge into test processes), `lib/log.ts`, `lib/llm/contextBudget.ts`
(import-free by design, so its decision is logged by the caller), every other
`console.*` call.

## Debug events (first set)

All fields below are ids, counts, durations, booleans or static identifiers.

| Event | Anchor (`backend/src/…`) | Fields |
|---|---|---|
| `llm.call.start` | `lib/llm/aiSdk.ts:689` `streamAiSdk` | model, provider, maxIterations, maxOutputTokens, inputBudget, toolCount, reasoning, metered |
| `llm.step.finish` | `aiSdk.ts:847` `finish-step` | model, step, inputTokens, outputTokens, finishReason, rawFinishReason |
| `llm.call.finish` | `aiSdk.ts:911` | model, steps, finishReason, planningRestarts, summarizedTurns, shortenedToolResults, outputChars, durationMs |
| `llm.provider_error` | `aiSdk.ts:926` catch | model, provider, errorType, failureKind, httpStatus, toolFailure |
| `llm.stream_abort` | `aiSdk.ts:893` `abort` | model, stalled, callerAborted |
| `llm.deadline_fired` | `lib/llm/providerDeadlines.ts:24` | model, provider, which (`first_chunk`/`chunk`), limitMs |
| `llm.length_followup` | `lib/llm/lengthContinuation.ts:220` | kind (`continue`/`recover`), used, max, finishReason, endedWriting, toolCallInStep |
| `llm.context_fit` | `aiSdk.ts` `prepareStep` (result of `contextBudget.ts` `fitMessagesToBudget`) | model, budget, fixedTokens, totalTokens, shortenedToolResults, summarizedTurns |
| `tool.call` | `modules/chat/engine/tools/toolDispatcher.ts:591` (emitted after loop) | toolName, toolCallId, durationMs, outcome, subagent |
| `doc.edit` | `toolDispatcher.ts:2031` | documentId, edits, ok, versionId, versionNumber |
| `doc.generate` | `toolDispatcher.ts:2487` | sections, landscape, numberSections, documentId |
| `delegate.start` | `tools/delegateTools.ts:617` `runDelegateCall` | delegationId, continuedFrom, model, effort, tier, maxSteps, timeoutMs, documents |
| `delegate.finish` | `delegateTools.ts:686` | delegationId, status, stopReason, inputTokens, outputTokens, records, errorCategory |
| `turn.claim` | `lib/assistantTurnRuns.ts:142` | surface, claimed (record carries chatId, runId) |
| `streamrun.claim` | `lib/streamRunCluster.ts` `claim()` | surface, claimed |
| `streamrun.finish` | `lib/streamRuns.ts:310` `finish()` | key surface, seq, stopReason, durationMs, bufferedBytes, bufferExhausted |
| `streamrun.stop` | `streamRuns.ts:332` | reason, seq |
| `streamrun.owner_lost` | `streamRuns.ts:388` (+ causes from :296, :378) | cause, seq |
| `relay.page_fetch_fail` | `streamRuns.ts:484` | failures, ownerInstance, cursor |
| `relay.dispatch` | `lib/streamRunCluster.ts:300` | op, ok |
| `conversion.job` | `modules/documents/documents.conversion.ts:31`, `:47` | documentId, versionId, finalize, outcome (`start`/`converted`/`convert_failed`), pdfBytes, errorCategory |
| `upload.job` | `modules/uploads/uploads.processing.ts:642`, `:651`, `:658`, `:665` | uploadJobId, attempts, sessionId, purpose, format (the file type), outcome, durationMs |
| `dbq.job` | `lib/dbq/runner.ts:237`, `:241`, `:278` | jobKind, attempts, maxAttempts, phase (`start`/`done`/`retry`/`defer`/`failed`), delayMs, leaseLost |

Info (always on, no per-tenant gate): `process.start`, `process.shutdown`,
`logging.debug_switch`; warn `logging.debug_switch_read_failed` once per failing
poll streak. Line numbers are as of `a035c35`-era `main`; re-locate by function
name if they drift. Field names avoid the deny-scan words (rule 3), hence
`errorType`, `endedWriting` and `format` rather than `errorName`, `endedInText`
and `fileType`. `tool.call` events are not emitted when the dispatch loop
throws.

## Where ambient context holds and where it does not

| Path | Context | Action |
|---|---|---|
| HTTP request after auth | tenant + user (auth ALS), request id | none |
| Delegate/sub-agent (`streaming.ts:893` `void startDelegation`) | started synchronously in the parent turn, inherits it | none; delegate events add `delegationId` |
| Timers created in a request (run idle/lifetime/grace/heartbeat, provider deadlines, delegate timeout) | inherit the creating scope | runs additionally use the explicit `runLog` |
| dbq / upload / BullMQ jobs | `runWithJobTenant` (tenant, actor user) | add `jobId` overlay |
| Relay `dispatch` (LISTEN notification) | tenant only | add `runId` overlay |
| Cluster pulse/reconnect, dbq poll/sweep, stale and MCP sweeps | none (platform) | none; records carry no tenant and debug never fires |
| Remote relay `subscribe` loop (`streamRuns.ts:470`) | the subscriber's request | acceptable; it serves that request |

Title generation (`titlePromise`) and memory scheduling in `chat.routes.ts` are
created after `bindLogContext`, so they inherit chat and run ids; the unit test
covers a promise created after the bind and awaited later. Not verified end to
end in a running app.

## Operations

Turn debug on for two hours (control plane, `control_plane` login):

```sql
select public.cp_set_tenant_debug('contoso');          -- returns end time
select public.cp_set_tenant_debug('contoso', 30);      -- 30 minutes
select public.cp_clear_tenant_debug('contoso');
```

Wait up to 30 s, reproduce, then query Log Analytics:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated between (datetime(2026-11-16T10:00:00Z) .. datetime(2026-11-16T10:30:00Z))
| where Log_s has "contoso"                     // cheap pre-filter before parsing
| extend r = parse_json(Log_s)
| where tostring(r.tenantId) == "contoso"
| project ts = todatetime(r.ts), level = tostring(r.level), event = tostring(r.event),
          msg = tostring(r.msg), userId = tostring(r.userId), chatId = tostring(r.chatId),
          runId = tostring(r.runId), requestId = tostring(r.requestId), data = r.data, err = r.err,
          ContainerAppName_s, RevisionName_s
| order by ts asc
```

One chat's failure, warnings and errors plus debug:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(4h) and Log_s has "9a2c…"
| extend r = parse_json(Log_s)
| where tostring(r.chatId) == "9a2c…" and tostring(r.level) in ("debug","warn","error")
| project ts = todatetime(r.ts), level = tostring(r.level), event = tostring(r.event),
          msg = tostring(r.msg), data = r.data, err = r.err
| order by ts asc
```

When the debug switch turns on or off, each process logs
`msg == "logging.debug_switch"`; search that to confirm the change arrived.

## Test plan

Unit (vitest, `backend/src/lib/logging/__tests__/`), all with `MemorySink` and a
fake clock; none touches the global `console`:

- `azureConsoleLogger.test.ts`: record shape and field omission; level → stream;
  `ts` from clock; `with()` precedence over ambient; Error/cause/AggregateError
  serialisation; key redaction; `redactSensitiveText` applied; 16,000-byte cap
  and `truncated`; never throws on circular/bigint/Buffer; text format.
- `debugEvents.test.ts`: debug dropped when gate off, without tenant, and after
  expiry; string allow-pattern redacts prose; arrays/objects redacted; field-name
  deny scan over `debugEvents.ts`.
- `contextLight.test.ts`: projection from `runWithTenant` + `runWithRequestId`
  never includes email/roles; overlay via `withLogContext` and `bindLogContext`;
  survives `await`, `setTimeout`, `setInterval`; concurrent scopes isolated;
  `runWithContextLight` does not change `currentTenant()`.
- `consoleBridge.test.ts`: install onto a fake `Console` object; each method maps
  to its level; first string → `msg`, rest → `args`; Error identity preserved for
  the wrapped original; `console.debug` gated; falls back to raw args if the
  logger throws; `uninstall()` restores.
- `tenantDebugSwitches.test.ts`: on until expiry then off without a refresh;
  24 h clamp; read failure clears (fail closed) and reports once per streak;
  stale `lastSuccessAt` → off; `onChange` on transitions; `stop()` clears timer.
- `root.test.ts`: default `NullLogger`; `resetRootLoggerForTests`.

Database (opt-in, same harness as
`src/__tests__/integration/namedMicrosoftMembers.postgres.test.ts`):
`tenantDebug.postgres.test.ts` — default 120 min returns `now()+2h`; 1 and 1440
accepted; 0, 1441 and null → 22023; unknown tenant → 23503 for both functions;
clear sets null; `control_plane` can execute both, `tenant_app`/`authenticated`
cannot; `tenant_rls_gaps()` and `control_plane_gaps()` empty after migration.

Commands (from `backend/`):

```
pnpm test                                            # whole suite; console spies must pass unchanged
pnpm test -- src/__tests__/architecture.test.ts
pnpm test -- src/lib/logging
pnpm build && pnpm typecheck:test
$env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://…"; npx vitest run src/__tests__/integration/tenantDebug.postgres.test.ts --testTimeout=60000
```

Run each `*.postgres.test.ts` file on its own: they share one migrator role and
race when vitest runs them in parallel.

Also run the existing Sentry console tests (`lib/observability/sentry*.test.ts`)
and `lib/processGuards.test.ts`. Manual check: `LOG_FORMAT=json pnpm dev`, make one
chat turn, confirm every line parses as JSON and carries `tenantId`/`userId`.

## Risks

- **Console patch order.** The bridge must be installed after `./telemetry` and
  before `initSentry`. If App Insights v3 hooks something other than `console`
  methods, its traces may change shape (JSON text instead of plain text); verify
  in the dev environment that traces still arrive.
- **Existing console lines can contain more than metadata** (e.g. provider error
  messages). The bridge does not make this worse and adds key and secret
  redaction, but it cannot prove the absence of content in 290 unreviewed calls.
  Debug events, the new surface, are enforced by the allow-list.
- **`enterWith`** leaks into whatever the calling async function does next; it
  is used only in the four turn routes, after the claim, where the rest of the
  function is the turn.
- **Volume and cost.** Debug for a busy tenant adds roughly 10–30 records per
  turn. The 24 h ceiling and auto-expiry bound it.
- **Worker-thread stdout** is relayed through the parent asynchronously; one
  `write` per record keeps lines intact.
- **Local dev output** uses the text format (`ts LEVEL [tenant/user] msg {…}`)
  unless `LOG_FORMAT=json` is set.

## Non-goals

- Rewriting existing `console.*` calls or `devLog`.
- Copying logs onto support reports or exposing them to customers.
- Any frontend or tenant-admin UI; a control-plane read view of the switch.
- Sampling, log shipping other than stdout, or new Azure resources.
- A platform-wide (non-tenant) debug switch.
