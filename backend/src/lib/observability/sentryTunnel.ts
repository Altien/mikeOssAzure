// Sentry tunnel logic for the web app's browser SDK.
//
// Upstream divergence (sync-log: 3bcac35a): upstream keeps this module in
// frontend/src/app/lib and runs it in a Next `/monitoring` route handler,
// with reportingDestination() in the frontend's errorReporting.ts. Dev's
// frontend is a static export (no route handlers, no Next server), so the
// tunnel is the backend's POST /api/monitoring and the destination rule lives
// here. Dev's rule has no baked NEXT_PUBLIC_* DSN and no community default:
// the web DSN is runtime-only (Key Vault `sentry-frontend-dsn`, then
// SENTRY_FRONTEND_DSN), exactly what GET /config serves.
import { MIKE_SENTRY_DSN, installKind, resolveDsn, type InstallKind } from "./sentry";
import { eventBudget, eventBudgetLimits } from "./sentryVolume";

/** The env the destination rule reads; the caller resolves the Key Vault DSN. */
export type TunnelEnv = {
    SENTRY_DISABLED?: string;
    /** Key Vault `sentry-frontend-dsn` first, then the SENTRY_FRONTEND_DSN env var. */
    SENTRY_FRONTEND_DSN?: string;
    SENTRY_ENVIRONMENT?: string;
    SENTRY_INSTALL?: string;
    /** Optional daily cap on repeat browser reports (blank: no cap). */
    SENTRY_MAX_REPEAT_EVENTS_PER_DAY?: string;
};

export type ReportingDestination = {
    /** Empty when reporting is off. */
    dsn: string;
    source: "disabled" | "runtime" | "none";
    /** Runtime overrides for every report; absent means "as sent". */
    environment?: string;
    install?: InstallKind;
};

/**
 * The ONE place that decides where the web app's browser reports go, in order:
 *
 *   SENTRY_DISABLED=true    off
 *   sentry-frontend-dsn     the deployment's web project (Key Vault, then
 *                           SENTRY_FRONTEND_DSN)
 *   otherwise               off: Dev has no default destination
 *
 * Answered by GET /api/monitoring (the rule, never the DSN).
 */
export function reportingDestination(env: TunnelEnv): ReportingDestination {
    const overrides = {
        ...(env.SENTRY_ENVIRONMENT?.trim() ? { environment: env.SENTRY_ENVIRONMENT.trim() } : {}),
        ...(env.SENTRY_INSTALL?.trim() ? { install: installKind(env.SENTRY_INSTALL) } : {}),
    };
    // Same "what counts as off" rule as the backend's own SDK.
    const resolved = resolveDsn({
        disabled: env.SENTRY_DISABLED,
        dsn: env.SENTRY_FRONTEND_DSN,
        fallback: "",
    });
    if (resolved.source === "disabled") return { dsn: "", source: "disabled", ...overrides };
    if (resolved.dsn) return { dsn: resolved.dsn, source: "runtime", ...overrides };
    return { dsn: "", source: "none", ...overrides };
}

/** Envelopes are small (the privacy boundary strips attachments); refuse more. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

export type TunnelDecision =
    | { kind: "drop" }
    | {
          kind: "forward";
          /** Sentry's envelope endpoint for the runtime-resolved DSN. */
          url: string;
          /** The DSN written into the envelope header (authenticates it). */
          dsn: string;
          /** Runtime overrides applied to every event item, when set. */
          environment?: string;
          install?: string;
      };

type ParsedDsn = { protocol: string; host: string; path: string; projectId: string };

function parseDsn(dsn: string): ParsedDsn | null {
    let url: URL;
    try {
        url = new URL(dsn);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // split() never yields an empty array, so pop() is a string; "" when the
    // DSN has no path at all.
    const projectId = segments.pop() as string;
    if (!url.username || !/^\d+$/.test(projectId)) return null;
    return { protocol: url.protocol.slice(0, -1), host: url.host, path: segments.length ? `/${segments.join("/")}` : "", projectId };
}

/**
 * Where a browser envelope goes: the `reportingDestination` rule above, the
 * same DSN GET /config hands the browser. A malformed DSN drops the envelope
 * rather than falling back anywhere: the operator asked for their own Sentry.
 */
export function tunnelDecision(env: TunnelEnv): TunnelDecision {
    const destination = reportingDestination(env);
    if (!destination.dsn) return { kind: "drop" };
    const parsed = parseDsn(destination.dsn);
    if (!parsed) return { kind: "drop" };
    return {
        kind: "forward",
        url: `${parsed.protocol}://${parsed.host}${parsed.path}/api/${parsed.projectId}/envelope/`,
        dsn: destination.dsn,
        ...(destination.environment ? { environment: destination.environment } : {}),
        ...(destination.install ? { install: destination.install } : {}),
    };
}

const NEWLINE = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lineEnd(bytes: Uint8Array, from: number): number {
    const index = bytes.indexOf(NEWLINE, from);
    return index === -1 ? bytes.length : index;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(decoder.decode(bytes));
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Re-emit an envelope with the header DSN replaced and, when the deployment
 * sets them, `environment` and `tags.install` applied to every event item.
 * Items are walked by the envelope framing (header line, then item header
 * and payload pairs; a `length` counts payload bytes) so payloads are never
 * misread; anything that does not parse returns null and is not forwarded.
 */
export function rewriteEnvelope(
    raw: Uint8Array,
    patch: { dsn: string; environment?: string; install?: string },
    acceptEvent?: (event: Record<string, unknown>) => boolean,
): Uint8Array | null {
    const headerEnd = lineEnd(raw, 0);
    const header = parseJsonObject(raw.subarray(0, headerEnd));
    if (!header) return null;
    header.dsn = patch.dsn;
    const parts: Uint8Array[] = [encoder.encode(JSON.stringify(header))];

    let cursor = headerEnd + 1;
    while (cursor < raw.length) {
        const itemHeaderEnd = lineEnd(raw, cursor);
        if (itemHeaderEnd === cursor) {
            // Blank line: trailing newline at the end of the envelope.
            cursor += 1;
            continue;
        }
        const itemHeader = parseJsonObject(raw.subarray(cursor, itemHeaderEnd));
        if (!itemHeader) return null;
        const payloadStart = itemHeaderEnd + 1;
        if (payloadStart > raw.length) return null;
        const declared = itemHeader.length;
        const payloadEnd =
            typeof declared === "number" && Number.isInteger(declared) && declared >= 0
                ? payloadStart + declared
                : lineEnd(raw, payloadStart);
        if (payloadEnd > raw.length) return null;
        let payload = raw.subarray(payloadStart, payloadEnd);

        if (itemHeader.type === "event" && (patch.environment || patch.install || acceptEvent)) {
            const event = parseJsonObject(payload);
            if (!event) return null;
            if (patch.environment) event.environment = patch.environment;
            if (patch.install) {
                const tags =
                    event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)
                        ? (event.tags as Record<string, unknown>)
                        : {};
                tags.install = patch.install;
                event.tags = tags;
            }
            if (acceptEvent && !acceptEvent(event)) { cursor = payloadEnd + 1; continue; }
            payload = encoder.encode(JSON.stringify(event));
            if (typeof declared === "number") itemHeader.length = payload.byteLength;
        }
        parts.push(encoder.encode(JSON.stringify(itemHeader)), payload);
        cursor = payloadEnd + 1;
    }

    if (acceptEvent && parts.length === 1) return new Uint8Array();
    const total = parts.reduce((sum, part) => sum + part.byteLength + 1, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
        out[offset] = NEWLINE;
        offset += 1;
    }
    return out;
}


// One bounded budget per tunnel process, reset only when destination/policy changes.
let browserBudget: { key: string; accepts: ReturnType<typeof eventBudget> } | undefined;
// Dev (sync-log: b8490837/bd719ea6): Dev's MIKE_SENTRY_DSN values are empty,
// so no runtime DSN matches a shared Mike project: the repeat cap applies only
// when SENTRY_MAX_REPEAT_EVENTS_PER_DAY is set, and there is no daily ceiling.
export function browserReportBudget(env: TunnelEnv): ReturnType<typeof eventBudget> {
    const destination = reportingDestination(env);
    const limits = eventBudgetLimits(env.SENTRY_MAX_REPEAT_EVENTS_PER_DAY, destination.dsn, Object.values(MIKE_SENTRY_DSN));
    const key = `${destination.dsn}:${limits.repeatEventsPerDay}:${limits.eventsPerDay}`;
    if (browserBudget?.key !== key) browserBudget = { key, accepts: eventBudget(limits) };
    return browserBudget.accepts;
}
