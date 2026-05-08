import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
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

// Container Apps' ingress terminates TLS and rewrites the request to the
// container as plain HTTP, with the original scheme + client host in
// X-Forwarded-Proto / X-Forwarded-Host / X-Forwarded-For. Without this,
// `req.protocol` reports "http" inside the container even when the user's
// browser is on https://, which breaks request-derived OAuth redirect_uri
// construction in routes/auth.ts (Microsoft rejects the http:// form).
app.set("trust proxy", true);

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

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
