/**
 * Final outbound boundary, after SDK processors and before transport serialization.
 * Mirrored in frontend/src/shared/lib/sentryPrivacy.ts; the sync test guards drift.
 * Never infer whether arbitrary text is PII. Rebuild diagnostic events from an
 * allowlist and reject every other envelope item, including automatic sessions.
 */
type RecordValue = Record<string, unknown>;
type Envelope = [RecordValue, Array<[{ type: string; [key: string]: unknown }, unknown]>];
interface Transport {
  send(envelope: Envelope): PromiseLike<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{16,32}$/i;
const ENUMS: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  service: 'mike-backend mike-frontend mike-word-addin',
  role: 'api worker worker-thread job',
  runtime: 'browser server edge',
  surface: 'taskpane commands dialog',
  install: 'community official',
  component: 'http mike-api api-gateway dbq storage upload-worker conversion-worker extraction-worker app-jobs chat-stream assistant-chat word-chat word-office boot shutdown worker-shutdown worker-thread worker-thread-supervisor stale-sweep mcp-refresh-sweep workflow-sync best-effort route-error-boundary global-error-boundary',
  stage: 'conversion heartbeat process-file iteration failure-hook claim tick retention delivery docx-to-pdf copy-rollback anchor-cleanup resolve-cleanup resolve restore reveal locate citation-select release document-read resolve-batch tool-result sealed-source-after-process failed-file-sealed session-expiry seal-mismatch seal-recover session-cancel user-prefix-cleanup failed-document-remove',
  http_method: 'GET POST PUT PATCH DELETE HEAD OPTIONS',
  error_code: 'internal_error network_error',
  office_code: 'GeneralException InvalidArgument InvalidObjectPath ItemNotFound AccessDenied NotAllowed DocumentNotSaved UnsupportedOperation InvalidOperation InvalidReference',
  office_host: 'Word',
  office_platform: 'PC Mac OfficeOnline Universal iOS Android',
  job_kind: 'audit.chat_turn account.delete storage.cleanup document.cleanup export.build conversion.convert extraction.extract mcp.refresh_token document.precompute_text memory.consolidate',
  storage: 'local cloud',
}).map(([key, values]) => [key, new Set(values.split(' '))]));
const ROUTE_PARTS = new Set(('api auth login logout refresh session user users projects documents versions files folders upload uploads upload-sessions parts complete abort content download preview source text conversion chats chat messages stream cancel assistant tabular tabular-reviews reviews rows columns cells run results export workflows templates library models settings profile organizations members permissions shares keys api-keys health observability sentry-test').split(' '));
const ID_KEYS = new Set(('request_id requestId document_id documentId file_id fileId job_id jobId review_id reviewId row_id rowId session_id sessionId version_id versionId').split(' '));
const ERROR_TYPES = new Set('Error TypeError RangeError ReferenceError SyntaxError URIError EvalError AggregateError AbortError TimeoutError APIError'.split(' '));
const LEVELS = new Set('fatal error warning info debug'.split(' '));

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

/** Only fixed route vocabulary survives; names, ids, queries and fragments do not. */
export function diagnosticRoute(value: string): string {
  return (value.replace(/^(?:https?:)?\/\/[^/]+/i, '').split(/[?#]/)[0] || '/')
    .split('/').slice(0, 16).map(part => !part || ROUTE_PARTS.has(part) ? part : ':id').join('/');
}

/** Stack locations are code, never the document currently being processed. */
function codePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.split(/[?#]/)[0]!.replace(/\\/g, '/');
  const bundle = clean.match(/(?:^|\/)((?:taskpane|commands|oauth-dialog|\d+)(?:\.[0-9a-f]{8})?\.js)$/);
  if (bundle) return bundle[1];
  const start = clean.search(/(?:^|\/)(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\//);
  const path = start >= 0 ? clean.slice(start).replace(/^\//, '') : clean;
  if (!/^(?:(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\/|\.\/|webpack(?:-internal)?:\/\/)/.test(path)) return undefined;
  return /^[\w@./()[\]~!:+ -]+\.[cm]?[jt]sx?$/.test(path) ? path : undefined;
}

function tagsFor(value: unknown): RecordValue {
  const out: RecordValue = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string' && Object.hasOwn(ENUMS, key) && ENUMS[key]!.has(entry)) out[key] = entry;
    else if (ID_KEYS.has(key) && typeof entry === 'string' && UUID.test(entry)) out[key] = entry;
    else if (key === 'office_version' && typeof entry === 'string' && /^\d+(?:\.\d+){1,4}$/.test(entry) && entry.length < 30) out[key] = entry;
    else if (key === 'http_route' && typeof entry === 'string') out[key] = diagnosticRoute(entry);
    else if (key === 'http_status' && /^\d{3}$/.test(String(entry)) && Number(entry) >= 100 && Number(entry) <= 599) out[key] = Number(entry);
    else if ((key === 'network' || key === 'project') && (entry === true || entry === false || entry === 'true' || entry === 'false')) out[key] = entry;
  }
  return out;
}

function framesFor(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap(raw => {
    const frame = record(raw);
    const filename = codePath(frame.filename) ?? codePath(frame.abs_path);
    if (!filename) return [];
    const out: RecordValue = { filename };
    // abs_path/debug ids are needed to match uploaded source maps.
    if (codePath(frame.abs_path)) out.abs_path = codePath(frame.abs_path);
    for (const key of ['lineno', 'colno']) {
      if (Number.isSafeInteger(frame[key]) && Number(frame[key]) >= 0) out[key] = frame[key];
    }
    if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
    // Omit function names, source snippets, local variables and SDK frame extras.
    return [out];
  });
}

/** Nested console Errors arrive as a stack string; retain locations, not its message. */
function consoleFrames(value: unknown): RecordValue[] {
  if (typeof value !== 'string') return [];
  return framesFor(value.split('\n').slice(1, 101).flatMap(line => {
    const match = line.match(/(?:\(|\s)((?:\/|[A-Za-z]:\\|https?:\/\/|webpack)[^\n]*?):(\d+):(\d+)\)?$/);
    return match ? [{ filename: match[1], lineno: Number(match[2]), colno: Number(match[3]) }] : [];
  }));
}

export function diagnosticEvent(value: unknown): RecordValue {
  const event = record(value);
  const tags = tagsFor(event.tags);
  const out: RecordValue = { tags };
  if (typeof event.event_id === 'string' && HEX_ID.test(event.event_id)) out.event_id = event.event_id;
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) out.timestamp = event.timestamp;
  if (typeof event.level === 'string' && LEVELS.has(event.level)) out.level = event.level;
  if (event.platform === 'javascript' || event.platform === 'node') out.platform = event.platform;
  // Release/environment are operator-supplied build configuration, never request data.
  for (const key of ['release', 'environment']) {
    if (typeof event[key] === 'string' && /^[\w@.+/-]{1,100}$/.test(event[key])) out[key] = event[key];
  }
  const description = [tags.component ?? 'application', tags.stage, tags.http_method, tags.http_route, tags.http_status, tags.error_code, tags.office_code].filter(v => v !== undefined).join(' / ');
  const values = record(event.exception).values;
  if (Array.isArray(values) && values.length) {
    out.exception = { values: values.slice(0, 10).map(raw => {
      const exception = record(raw);
      const type = typeof exception.type === 'string' && ERROR_TYPES.has(exception.type) ? exception.type : 'Error';
      const safe: RecordValue = { type, value: `Failure in ${description}` };
      const frames = framesFor(record(exception.stacktrace).frames);
      if (frames.length) safe.stacktrace = { frames };
      const handled = record(exception.mechanism).handled;
      if (typeof handled === 'boolean') safe.mechanism = { type: 'generic', handled };
      return safe;
    }) };
  } else {
    out.message = `Failure in ${description}`;
    const frames = framesFor(record(event.stacktrace).frames);
    frames.push(...consoleFrames(record(event.extra).error_stack));
    if (frames.length) out.stacktrace = { frames };
  }
  // Group by code location and controlled operation, never arbitrary text.
  out.fingerprint = ['{{ default }}', String(tags.component ?? 'application'), String(tags.stage ?? ''), String(tags.http_route ?? ''), String(tags.http_status ?? '')];
  const extra: RecordValue = {};
  for (const [key, entry] of Object.entries(record(event.extra))) {
    if (ID_KEYS.has(key) && typeof entry === 'string' && UUID.test(entry)) extra[key] = entry;
  }
  if (Object.keys(extra).length) out.extra = extra;
  const images = record(event.debug_meta).images;
  if (Array.isArray(images)) {
    const safeImages = images.flatMap(raw => {
      const image = record(raw);
      const code_file = codePath(image.code_file);
      return image.type === 'sourcemap' && typeof image.debug_id === 'string' && UUID.test(image.debug_id) && code_file
        ? [{ type: 'sourcemap', code_file, debug_id: image.debug_id }] : [];
    });
    if (safeImages.length) out.debug_meta = { images: safeImages };
  }
  return out;
}

/** Drop all non-error telemetry, even if a future SDK enables it by default. */
export function diagnosticEnvelope(envelope: Envelope, destination?: string): Envelope | null {
  const items: Envelope[1] = envelope[1].flatMap(([header, payload]) => header.type === 'event'
    ? [[{ type: 'event' }, diagnosticEvent(payload)] as Envelope[1][number]] : []);
  if (!items.length) return null;
  const header: RecordValue = {};
  // Next's tunnel needs a DSN. Use client configuration, never envelope input.
  if (destination && envelope[0].dsn !== undefined) header.dsn = destination;
  const id = envelope[0].event_id;
  if (typeof id === 'string' && HEX_ID.test(id)) header.event_id = id;
  return [header, items];
}

/** Applies to browser, server, workers and add-in, in both install modes. */
export function privacyBoundaryIntegration() {
  return {
    name: 'MikePrivacyBoundary',
    setup(client: {
      getTransport(): Transport | undefined;
      getDsn?(): { protocol: string; publicKey?: string; host: string; port?: string; path?: string; projectId: string } | undefined;
    }) {
      const transport = client.getTransport();
      if (!transport) return;
      const send = transport.send.bind(transport);
      const dsn = client.getDsn?.();
      const destination = dsn?.publicKey ? `${dsn.protocol}://${dsn.publicKey}@${dsn.host}${dsn.port ? `:${dsn.port}` : ''}/${dsn.path ? `${dsn.path}/` : ''}${dsn.projectId}` : undefined;
      let windowStart = Date.now();
      let sent = 0;
      transport.send = envelope => {
        const safe = diagnosticEnvelope(envelope, destination);
        if (!safe) return Promise.resolve({});
        const now = Date.now();
        if (now - windowStart >= 60_000) { windowStart = now; sent = 0; }
        // Runtime-wide bound supplements per-issue throttling; not an auth boundary.
        if (sent + safe[1].length > 60) return Promise.resolve({});
        sent += safe[1].length;
        return send(safe);
      };
    },
  };
}
