// Order matters here.
//   1. dotenv/config: loads .env into process.env so the next line can
//      read APPLICATIONINSIGHTS_CONNECTION_STRING from a local .env in
//      dev. (In Azure the env var comes from Container App secretRef,
//      no .env file involved.)
//   2. telemetry: applicationinsights' auto-instrumentation patches
//      require()/import at module-load time, so anything network-y
//      (http, express, pg, ...) MUST be imported AFTER this for those
//      calls to be captured. dotenv is a one-shot file reader with no
//      network/DB side effects, so it's safe before telemetry.
import "dotenv/config";
import "./telemetry";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
// Security middleware below is taken directly from upstream ba6f771
// ("Sync security and backend profile updates"). Adapted to dev's
// `/api/` route prefix for per-route limiter decorators.
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { authRouter } from "./routes/auth";
import { llmRouter } from "./routes/llm";
import { diagnosticsRouter } from "./routes/diagnostics";
import { installRouter } from "./routes/install";
import { configRouter } from "./routes/config";

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";

// ── Rate-limit configuration (from upstream ba6f771) ───────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail:
        options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
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

// ───────────────────────────────────────────────────────────────────────────

app.disable("x-powered-by");

// Container Apps' ingress terminates TLS and rewrites the request to the
// container as plain HTTP, with the original scheme + client host in
// X-Forwarded-Proto / X-Forwarded-Host / X-Forwarded-For. Without this,
// `req.protocol` reports "http" inside the container even when the user's
// browser is on https://, which breaks request-derived OAuth redirect_uri
// construction in routes/auth.ts (Microsoft rejects the http:// form).
app.set("trust proxy", true);

// helmet (security headers) — taken from upstream ba6f771; CSP and COEP
// stay disabled because dev serves a static-exported Next.js bundle from
// the same origin and we don't want to re-derive the policy on every
// frontend change. HSTS only in production.
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

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

// Global rate limit. Per-route stricter limiters are decorated before
// the route mounts below.
app.use(generalLimiter);

app.use(express.json({ limit: "50mb" }));
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
app.post("/api/projects/:projectId/chat", chatLimiter);
app.post("/api/tabular-review/:reviewId/chat", chatLimiter);
app.post("/api/tabular-review/:reviewId/generate", chatLimiter);
app.post("/api/chat/create", chatCreateLimiter);
app.post("/api/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/api/single-documents", uploadLimiter);
app.post("/api/single-documents/:documentId/versions", uploadLimiter);
app.post("/api/projects/:projectId/documents", uploadLimiter);

app.use("/api/chat", chatRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/chat", projectChatRouter);
app.use("/api/single-documents", documentsRouter);
app.use("/api/tabular-review", tabularRouter);
app.use("/api/workflows", workflowsRouter);
app.use("/api/user", userRouter);
app.use("/api/users", userRouter);
app.use("/api/download", downloadsRouter);
app.use("/api/auth", authRouter);
app.use("/api/llm", llmRouter);
app.use("/api/admin/diagnostics", diagnosticsRouter);
app.use("/install", installRouter);
app.use("/config", configRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ── Static frontend ────────────────────────────────────────────────────────
// In production the Dockerfile copies the Next.js static export to
// /app/public. When running from `dist/index.js`, __dirname is
// /app/dist, so the public dir is one level up. The directory is
// optional — local backend dev (npm run dev) doesn't have it, and the
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

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
