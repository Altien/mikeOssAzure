# Issue 028 — Move Backend API to `/api/*` Prefix

## Goal

Prefix every backend API mount with `/api/` so frontend SPA paths (which share the same Express server) can never collide with backend route handlers. Retire the browser-navigation `Accept`-header intercept added under issue-027-debug.

## Context

The backend currently mounts API routers at the same root paths the frontend uses for SPA routes:

| Backend mount                     | Frontend SPA route                |
|-----------------------------------|-----------------------------------|
| `/chat`                           | `/assistant/chat/[id]`            |
| `/projects`                       | `/projects/[id]`                  |
| `/projects/:projectId/chat`       | `/projects/[id]/assistant/chat/…` |
| `/single-documents`               | n/a (API only — but still safer)  |
| `/tabular-review`                 | `/tabular-review/[id]`            |
| `/workflows`                      | `/workflows`                      |
| `/user`, `/users`                 | `/account` paths                  |
| `/auth`                           | `/login`                          |

This collision means any direct browser navigation or refresh to a frontend route that overlaps an API mount hit `requireAuth` first (no `Authorization` header on a fresh page load — the token lives in `localStorage`, not cookies) and returned **401** instead of the SPA shell.

The current workaround (commit `81cb4ab`) is an `app.get("*")` middleware before the API routers that intercepts requests with `Accept: text/html` + no `Authorization` header and serves the SPA shell. It works, but it relies on browser-header conventions that aren't always reliable:

- A `curl` to `/projects` without a token gets the HTML SPA shell instead of a clean 401, which is confusing for debugging.
- A frontend bug that strips the `Authorization` header would silently get HTML instead of an auth error.
- An outbound webhook receiver or a CLI tool that doesn't send `Accept: application/json` would get HTML.

A `/api/*` prefix removes the ambiguity entirely.

## What to build

### Backend

`backend/src/index.ts` — change every API mount from `/x` to `/api/x`:

```ts
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
app.get("/api/health", …);
```

Once everything is under `/api/*`, delete the browser-nav `Accept` intercept and the `findShell` factor introduced for it (or keep `findShell` only as the helper for the bottom RSC fallback). The bottom SPA fallback already skips `/api`-prefixed paths via the existing `req.path.startsWith("/api")` check.

### Frontend

`frontend/src/app/lib/mikeApi.ts` — `apiRequest` constructs URLs as `${API_BASE}${path}`. Either:

- Change `API_BASE` to include `/api` (e.g., `http://localhost:3001/api`), and update every `apiRequest("/chat", …)` etc. call site to drop the leading slash mismatch — but this changes nothing in the call sites, just the env var and `apiRequest` body.
- Or change every call site path from `"/chat"` to `"/api/chat"`.

Recommended: bake `/api` into `API_BASE` (single change) so call-site paths stay readable.

Also check direct fetches that bypass `apiRequest` (search the frontend for `fetch(\`${API_BASE}` and similar). Each needs the same prefix.

### Local dev

The local Caddy gateway in `scripts/local-stack/Caddyfile` proxies PostgREST already; no changes needed there. Backend dev server (`npm run dev`) and the bundled production server both pick up the prefix automatically once `index.ts` is updated.

## Acceptance criteria

- [ ] All backend API routes are at `/api/*`. No backend handler responds at the root for paths that overlap SPA routes.
- [ ] Direct browser navigation and hard refresh of every frontend route works (`/projects/<id>`, `/assistant/chat/<id>`, `/workflows/<id>`, `/tabular-review/<id>`, etc.).
- [ ] `curl /projects` (no `/api/` prefix, no token) returns the SPA shell HTML — confirms the routing is shape-based, not header-sniffed.
- [ ] `curl /api/projects` (no token) returns a 401 JSON `{"detail": "Missing or invalid Authorization header"}` — confirms API auth still works.
- [ ] Browser-nav `Accept` intercept and `findShell` helper used solely for it are removed from `backend/src/index.ts`.
- [ ] Frontend builds and all pages load post-rename.

## Out of scope

- Renaming the frontend routes themselves.
- Versioning the API (`/api/v1/...`) — defer until externally consumed.
- Splitting backend and frontend into separate Container Apps (a larger change tracked elsewhere if it ever happens).

## Related

- Commit `81cb4ab` — the browser-nav intercept this issue retires.
- Issue 027 — MSAL silent token refresh (orthogonal, but both touch the auth flow).
