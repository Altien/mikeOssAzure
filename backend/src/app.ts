import express from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
// Security middleware below is taken directly from upstream ba6f771
// ("Sync security and backend profile updates"). Adapted to dev's
// `/api/` route prefix for per-route limiter decorators.
import { chatRouter } from "./modules/chat/chat.routes";
import { wordChatRouter } from "./modules/word-chat/wordChat.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { orgsRouter } from "./modules/orgs/orgs.routes";
import { projectChatRouter } from "./modules/project-chat/projectChat.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { libraryRouter } from "./modules/library/library.routes";
import { tabularRouter } from "./modules/tabular/tabular.routes";
import { workflowsRouter } from "./modules/workflows/workflows.routes";
import { quickActionsRouter } from "./modules/quick-actions/quickActions.routes";
import { workflowAddonsRouter } from "./modules/workflows/workflowAddons.routes";
import { userRouter } from "./modules/user/user.routes";
import { modelsRouter } from "./modules/models/models.routes";
import { downloadsRouter } from "./modules/downloads/downloads.routes";
import { sourceDocumentsRouter } from "./modules/source-documents/sourceDocuments.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { uploadSessionsRouter } from "./modules/uploads/uploads.routes";
import { llmRouter } from "./modules/platform/llm.routes";
import { diagnosticsRouter } from "./modules/platform/diagnostics.routes";
import { installRouter } from "./modules/platform/install.routes";
import { configRouter } from "./modules/platform/config.routes";
import { diagRouter } from "./modules/platform/diag.routes";
import {
  projectMemoryRouter,
  userMemoryRouter,
} from "./modules/memory/memory.routes";
import { manifestPublicKey } from "./lib/manifestSigning";
import { safeErrorLog } from "./lib/safeError";
import { authorityTraceRouter } from "./altien/authorityTrace/router";
import { skillsRouter } from "./altien/skills/router";
import { helpRouter } from "./modules/platform/help.routes";
import { handleUnhandledError, protectInternalErrorResponses } from "./middleware/internalErrorResponse";
import { configuredAllowedOrigins as configuredOrigins } from "./lib/origins";
import { envInt } from "./lib/runtimeConfig";
import { tagCurrentRequest } from "./lib/observability/sentry";

// ── Rate-limit configuration (from upstream ba6f771) ───────────────────────

// Ceiling for JSON API requests. File bytes upload directly to object storage;
// only small upload-session manifests and control requests reach Express.
const JSON_BODY_LIMIT = "50mb";
const TOOL_RESULT_PATH = "/api/word-chat/tool-result";

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

// Only known static-export paths bypass the general limiter. An extension by
// itself is not sufficient: dynamic routes can legitimately end in `.txt`
// (for example `/install/items/:id`).
const PUBLIC_ASSET =
  /^\/(?:branding|icons)\/|^\/(?:apple-touch-icon\.png|file\.svg|globe\.svg|link-image\.jpg|next\.svg|vercel\.svg|window\.svg|workflow\.svg)$/i;
const NEXT_RSC_PAYLOAD = /(?:^|\/)__next(?:\.|\/).*\.txt$/i;

export function isStaticAsset(req: { method: string; path: string }): boolean {
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    (req.path.startsWith("/_next/") ||
      PUBLIC_ASSET.test(req.path) ||
      NEXT_RSC_PAYLOAD.test(req.path))
  );
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  skip?: (req: express.Request) => boolean;
  keyGenerator?: (req: express.Request) => string;
  skipSuccessfulRequests?: boolean;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS" || options.skip?.(req) === true,
    keyGenerator: options.keyGenerator,
    skipSuccessfulRequests: options.skipSuccessfulRequests,
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

// Upstream divergence (sync-log: 3a10943): upstream also added a
// jsonLimitForPath() indirection around express.json; it returns a
// constant "50mb" today, which is exactly dev's existing
// express.json({ limit: "50mb" }) below — not adopted.

/**
 * Build the Express app. Pure construction — no `app.listen()`. Tests
 * mount the returned app via `supertest` without binding a port; the
 * production entrypoint (`src/index.ts`) calls `.listen(PORT)` on the
 * result.
 *
 * Env reads (rate-limit windows, FRONTEND_URL, NODE_ENV) and filesystem
 * checks (PUBLIC_DIR existence) happen on every call so tests that
 * mutate env between cases see fresh values.
 */
export function configuredAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return configuredOrigins(env);
}

export function buildApp(): express.Express {
  const app = express();
  const isProduction = process.env.NODE_ENV === "production";

  const generalLimiter = makeLimiter({
    windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
    max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
    skip: (req) => req.path === TOOL_RESULT_PATH || req.path.startsWith("/api/upload-sessions"),
  });

  const toolResultLimiter = makeLimiter({
    windowMs: minutes(envInt("RATE_LIMIT_TOOL_RESULT_WINDOW_MINUTES", 15)),
    max: envInt("RATE_LIMIT_TOOL_RESULT_MAX", 2000),
    message: "Too many tool results. Please try again later.",
  });

  const chatLimiter = makeLimiter({
    windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
    max: envInt("RATE_LIMIT_CHAT_MAX", 30),
    message: "Too many chat requests. Please try again later.",
  });

  const chatCreateLimiter = makeLimiter({
    windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
    max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
  });

  const uploadLimiter = makeLimiter({
    windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
    max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
    message: "Too many upload requests. Please try again later.",
  });

  const exportLimiter = makeLimiter({
    windowMs: hours(envInt("RATE_LIMIT_EXPORT_WINDOW_HOURS", 1)),
    max: envInt("RATE_LIMIT_EXPORT_MAX", 10),
    message: "Too many export requests. Please try again later.",
  });

  const dataDeleteLimiter = makeLimiter({
    windowMs: hours(envInt("RATE_LIMIT_DATA_DELETE_WINDOW_HOURS", 1)),
    max: envInt("RATE_LIMIT_DATA_DELETE_MAX", 20),
    message: "Too many data deletion requests. Please try again later.",
  });

  app.disable("x-powered-by");

  // Container Apps' ingress terminates TLS and rewrites the request to the
  // container as plain HTTP, with the original scheme + client host in
  // X-Forwarded-Proto / X-Forwarded-Host / X-Forwarded-For. Without this,
  // `req.protocol` reports "http" inside the container even when the user's
  // browser is on https://, which breaks request-derived OAuth redirect_uri
  // construction in routes/auth.ts (Microsoft rejects the http:// form).
  //
  // Use the exact hop count (CA ingress = 1 proxy), NOT `true`. `true` trusts
  // the whole X-Forwarded-For chain, so a client can spoof XFF to dodge the
  // IP-based rate limiters below — express-rate-limit@8 rejects it with
  // ERR_ERL_PERMISSIVE_TRUST_PROXY. `1` still honors X-Forwarded-Proto for the
  // OAuth redirect_uri and uses the ingress-stamped client IP for rate limiting.
  app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    // Same id on the Sentry event, the response body, and the access log.
    tagCurrentRequest(requestId);
    next();
  });
  app.use(protectInternalErrorResponses);

  // helmet (security headers) — taken from upstream ba6f771; CSP and COEP
  // stay disabled because dev serves a static-exported Next.js bundle from
  // the same origin and we don't want to re-derive the policy on every
  // frontend change. HSTS only in production.
  // Upstream divergence (sync-log: 44e868e): upstream switched to a strict
  // CSP (default-src/base-uri/frame-ancestors 'none'). That works for
  // upstream's API-only backend, but dev's backend serves the SPA shell +
  // assets from the same origin — a 'none' default-src would block every
  // script/style in the served frontend. Do not adopt without authoring a
  // real policy for the bundled frontend.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction
        ? {
            maxAge: 15552000,
            includeSubDomains: true,
          }
        : false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  const allowedOrigins = configuredAllowedOrigins();

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server requests (no Origin header) and any
        // explicitly listed origin. A disallowed origin resolves to `false`
        // (cors omits the Access-Control-Allow-Origin header and the browser
        // blocks the response) rather than calling back with an Error —
        // throwing here would propagate to Express's default handler and turn
        // every disallowed cross-origin request, including preflight, into an
        // HTTP 500.
        callback(null, !origin || allowedOrigins.has(origin));
      },
      credentials: true,
      allowedHeaders: ["Authorization", "Content-Type", "X-Upload-Generation"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Global rate limit. Per-route stricter limiters are decorated before
  // the route mounts below. Bundled-frontend assets are exempt: one page
  // load fetches dozens of JS/CSS chunks, which exhausted the 300/15 min
  // budget after ~20 page loads (OSS-6 smoke, 2026-09-30).
  const uploadPartPath = /^\/api\/upload-sessions\/[^/]+\/files\/[^/]+\/parts\/\d+$/;
  app.use((req, res, next) =>
    isStaticAsset(req) || (req.method === "PUT" && uploadPartPath.test(req.path))
      ? next() : generalLimiter(req, res, next),
  );

  // Parse this return channel before the general 50 MB parser. Its full
  // /api path also gives it a separate limiter budget under static hosting.
  app.post(TOOL_RESULT_PATH, toolResultLimiter, express.json({ limit: "2mb" }));
  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
  // Blob parts are bounded streams. Never let the global JSON parser buffer a
  // mislabeled 8 MiB part (or the global 50 MiB ceiling) before ownership and
  // part-size checks in the upload router.
  app.use((req, res, next) =>
    req.method === "PUT" && uploadPartPath.test(req.path)
      ? next()
      : jsonParser(req, res, next),
  );
  // /install posts form-encoded bodies (the bootstrap-token paste form).
  // Limit is small — the only field is a token + maybe a few config values.
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(cookieParser());

  // ── Static frontend bundle (must be set up BEFORE the API routers below) ──
  const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
  const FRONTEND_BUNDLED = fs.existsSync(PUBLIC_DIR);

  // Resolve the static-export shell file for `reqPath`. Returns a path on disk
  // or null. Tries the literal path first, then dynamic-segment substitutions
  // with `_` (Next.js export's placeholder for [id] params), most-specific
  // first. Used by the RSC fallback at the bottom of this file.
  function findShell(reqPath: string): string | null {
    if (!FRONTEND_BUNDLED) return null;
    const ext = path.extname(reqPath);
    const isRscTxt = ext === ".txt";
    if (ext && !isRscTxt) return null;

    const lookup = isRscTxt ? reqPath.slice(0, -".txt".length) : reqPath;
    const segments = lookup.split("/").filter(Boolean);

    const candidates: string[] = [segments.join("/")]; // literal first
    for (let i = segments.length - 1; i >= 0; i--) {
      const c = [...segments];
      c[i] = "_";
      candidates.push(c.join("/"));
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const c = [...segments];
        c[i] = "_";
        c[j] = "_";
        candidates.push(c.join("/"));
      }
    }

    for (const candidate of candidates) {
      // Next.js export emits the shell as `<candidate>.html` at the parent
      // level (e.g. `/projects/_.html`).  It also creates a `<candidate>/`
      // directory holding nested-route shells, so we fall back to
      // `<candidate>/index.html` for older Next exports / non-dynamic routes
      // that might use that layout.
      const targets = isRscTxt
        ? [path.join(PUBLIC_DIR, `${candidate}.txt`)]
        : [
            path.join(PUBLIC_DIR, `${candidate}.html`),
            path.join(PUBLIC_DIR, candidate, "index.html"),
          ];
      for (const target of targets) {
        if (fs.existsSync(target)) return target;
      }
    }
    return null;
  }

  // Per-route rate limiters (from upstream ba6f771, adapted to dev's
  // /api/ prefix). Must be registered before the corresponding router
  // mounts so express runs them ahead of the route handler.
  app.post("/api/chat", chatLimiter);
  app.post("/api/word-chat", chatLimiter);
  app.post("/api/projects/:projectId/chat", chatLimiter);
  app.post("/api/tabular-review/:reviewId/chat", chatLimiter);
  app.post("/api/tabular-review/:reviewId/generate", chatLimiter);
  app.post("/api/chat/create", chatCreateLimiter);
  app.post("/api/single-documents", uploadLimiter);
  app.post("/api/library/:kind/documents", uploadLimiter);
  app.post("/api/single-documents/:documentId/versions", uploadLimiter);
  app.post("/api/workflows/:workflowId/reference-files", uploadLimiter);
  app.post("/api/workflow-addons/:addonId/import", uploadLimiter);
  app.put("/api/workflows/:workflowId/reference-files/:referenceId", uploadLimiter);
  app.put(
    "/api/single-documents/:documentId/versions/:versionId/file",
    uploadLimiter,
  );
  app.post("/api/projects/:projectId/documents", uploadLimiter);
  app.post("/api/upload-sessions", uploadLimiter);
  app.get("/api/projects/:projectId/export", exportLimiter);
  app.post("/api/altien/skills/imports/zip", uploadLimiter);
  app.post("/api/altien/skills/imports/github", uploadLimiter);
  // Export / data-deletion limiters (upstream 3a10943). Scheduling an async
  // export costs what the synchronous project export above costs, so it
  // shares its budget. Deliberately POST-only: the /user/exports/:id poll and
  // its download stay on the general limiter (upstream 33facdba removed the
  // synchronous user/audit export GETs and the /api/users alias).
  app.post("/api/user/exports", exportLimiter);
  app.delete("/api/user/account", dataDeleteLimiter);
  app.delete("/api/user/chats", dataDeleteLimiter);
  app.delete("/api/user/projects", dataDeleteLimiter);
  app.delete("/api/user/tabular-reviews", dataDeleteLimiter);

  app.use("/api/chat", chatRouter);
  app.use("/api/word-chat", wordChatRouter);
  app.use("/api/user/memory", userMemoryRouter);
  app.use("/api/projects/:projectId/memory", projectMemoryRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/orgs", orgsRouter);
  app.use("/api/projects/:projectId/chat", projectChatRouter);
  app.use("/api/single-documents", documentsRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/tabular-review", tabularRouter);
  app.use("/api/workflows", workflowsRouter);
  app.use("/api/quick-actions", quickActionsRouter);
  app.use("/api/workflow-addons", workflowAddonsRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/user", userRouter);
  app.use("/api/download", downloadsRouter);
  app.use("/api/documents", sourceDocumentsRouter);
  app.use("/api/help", helpRouter);
  app.use("/api/upload-sessions", uploadSessionsRouter);
  app.use("/api/authority-trace", authorityTraceRouter);
  app.use("/api/altien/skills", skillsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/llm", llmRouter);
  app.use("/api/admin/diagnostics", diagnosticsRouter);
  app.use("/install", installRouter);
  app.use("/config", configRouter);
  // Keep the OSS operator diagnostic outside the SPA fallback so it remains
  // available while authentication is being configured.
  app.use("/diag", diagRouter);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  if (process.env.SENTRY_ENABLE_TEST_ROUTE === "true") {
    app.get("/api/observability/sentry-test", () => {
      throw Object.assign(
        new Error("Sentry backend test error (SENTRY_ENABLE_TEST_ROUTE)"),
        { code: "sentry_test" },
      );
    });
  }

  // The Ed25519 public key this deployment signs project export manifests
  // with, or null when no key is configured. Deliberately open: whoever checks
  // a manifest is usually outside the workspace and needs the key from the
  // server rather than the copy inside the file they were handed.
  // (Dev: /api-prefixed; upstream serves it at /manifest-signing-key.)
  app.get("/api/manifest-signing-key", (_req, res) => {
    try {
      res.json(manifestPublicKey());
    } catch (err) {
      console.error("[manifest-signing-key] failed", safeErrorLog(err));
      res.status(500).json({ detail: "Manifest signing key is misconfigured" });
    }
  });

  // ── Static frontend ────────────────────────────────────────────────────────
  // In production the Dockerfile copies the Next.js static export to
  // /app/public. When running from `dist/index.js`, __dirname is
  // /app/dist, so the public dir is one level up. The directory is
  // optional — local backend development doesn't have it, and the
  // frontend's own dev server at :3000 calls this backend over CORS.
  //
  // Order: API routers above handle every `/api/*` request. Anything
  // else falls through to express.static and then the SPA shell
  // fallback, which serves the right Next.js shell for direct browser
  // navs to `/projects/<id>` etc. RSC `.txt` payloads with no matching
  // shell 404 cleanly so Next can fall back to a hard navigation.

  if (FRONTEND_BUNDLED) {
    console.log(`Serving static frontend from ${PUBLIC_DIR}`);
    app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

    app.get("*", (req, res, next) => {
      if (req.method !== "GET") return next();
      if (req.path.startsWith("/api")) return next();

      const shell = findShell(req.path);
      if (shell) return res.sendFile(shell);

      // RSC `.txt` requests with no matching shell should 404 cleanly so
      // Next.js can fall back to a hard navigation, rather than receiving
      // an HTML root-index payload.
      if (path.extname(req.path) === ".txt") return next();
      res.sendFile(path.join(PUBLIC_DIR, "index.html"));
    });
  }

  app.use(handleUnhandledError);
  return app;
}
