// Sentry tunnel for the web app's browser SDK (SENTRY_TUNNEL_PATH in
// frontend/src/app/lib/errorReporting.ts).
//
// Upstream divergence (sync-log: 3bcac35a): upstream serves this as a Next
// route handler at /monitoring. Dev's frontend is a static export with no
// route handlers, so the backend serves it at /api/monitoring with the same
// behaviour: 204 when reporting is off, forward to the runtime DSN with the
// deployment's environment/install stamped on, GET answers the rule.
//
// This is not an open relay. The destination comes from the server's own
// configuration (Key Vault `sentry-frontend-dsn`, then SENTRY_FRONTEND_DSN,
// the DSN GET /config serves), never from the request; the client's envelope
// header is overwritten with that DSN. Nothing in the envelope is logged or
// stored.
import { Router, type Request } from "express";
import { getKeyVaultConfig } from "../../lib/config";
import {
    MAX_ENVELOPE_BYTES,
    browserReportBudget,
    reportingDestination,
    rewriteEnvelope,
    tunnelDecision,
    type TunnelEnv,
} from "../../lib/observability/sentryTunnel";

export const monitoringRouter = Router();

async function tunnelEnv(): Promise<TunnelEnv> {
    const vaultDsn = await getKeyVaultConfig("sentry-frontend-dsn").catch(() => "");
    return {
        SENTRY_DISABLED: process.env.SENTRY_DISABLED,
        SENTRY_FRONTEND_DSN: vaultDsn || process.env.SENTRY_FRONTEND_DSN,
        SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
        SENTRY_INSTALL: process.env.SENTRY_INSTALL,
        SENTRY_MAX_REPEAT_EVENTS_PER_DAY: process.env.SENTRY_MAX_REPEAT_EVENTS_PER_DAY,
    };
}

type ReadResult = { kind: "ok"; body: Buffer } | { kind: "too-large" } | { kind: "failed" };

/** Count bytes as they arrive: Content-Length may be absent or dishonest. */
async function readBounded(req: Request): Promise<ReadResult> {
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        for await (const chunk of req as AsyncIterable<Buffer | string>) {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            length += bytes.byteLength;
            if (length > MAX_ENVELOPE_BYTES) {
                // The answer is 413 whatever happens to the abandoned stream.
                req.unpipe();
                req.resume();
                return { kind: "too-large" };
            }
            chunks.push(bytes);
        }
    } catch {
        return { kind: "failed" };
    }
    return { kind: "ok", body: Buffer.concat(chunks, length) };
}

let warnedUnreachable = false;

monitoringRouter.post("/", async (req, res) => {
    const env = await tunnelEnv();
    const decision = tunnelDecision(env);
    if (decision.kind === "drop") {
        // Drain so the browser's keep-alive connection is not left half-read.
        req.resume();
        res.status(204).end();
        return;
    }

    const declaredLength = Number(req.headers["content-length"] ?? "0");
    if (declaredLength > MAX_ENVELOPE_BYTES) {
        req.resume();
        res.status(413).end();
        return;
    }
    const read = await readBounded(req);
    if (read.kind === "too-large") { res.status(413).end(); return; }
    if (read.kind === "failed" || read.body.byteLength === 0) { res.status(400).end(); return; }

    const envelope = rewriteEnvelope(read.body, decision, browserReportBudget(env));
    if (!envelope) { res.status(400).end(); return; }
    if (envelope.byteLength === 0) { res.status(204).end(); return; }

    try {
        const upstream = await fetch(decision.url, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: { "Content-Type": "application/x-sentry-envelope" },
            body: envelope.buffer.slice(
                envelope.byteOffset,
                envelope.byteOffset + envelope.byteLength,
            ) as ArrayBuffer,
        });
        // Rate-limit headers let the browser SDK back off; nothing else of
        // Sentry's response is of use to the client.
        for (const name of ["retry-after", "x-sentry-rate-limits"]) {
            const value = upstream.headers.get(name);
            if (value) res.setHeader(name, value);
        }
        // Release the connection without letting a stream error masquerade
        // as a failed send.
        void upstream.body?.cancel().catch(() => {});
        res.status(upstream.status).end();
    } catch {
        if (!warnedUnreachable) {
            warnedUnreachable = true;
            console.warn("[sentry] browser error reports could not be forwarded to Sentry");
        }
        res.status(502).end();
    }
});

/**
 * Which rule decides where this deployment's browser reports go, for
 * operators checking a running app (`curl -s https://<host>/api/monitoring`).
 * The rule only, never the DSN.
 */
monitoringRouter.get("/", async (_req, res) => {
    const { source } = reportingDestination(await tunnelEnv());
    res.set("Cache-Control", "no-store");
    res.json({ reports: source, see: "docs/observability.md#release-identity-source-maps-and-the-tunnel" });
});
