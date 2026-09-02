# 041 — Download click crash-loops the backend (missing download-signing-secret)

**Status: resolved.**

## Customer report (2026-07, backend:1.0.9, template deploy, West US 2)

Clicking Download (Projects → Documents → "…" → Download) returned HTTP 503
with the Envoy body "upstream connect error … delayed connect error". Container
Apps system logs showed `ProcessExited` exit code 1 with repeated restarts.
The customer attributed it to Azure Blob SAS generation throwing — that part
was wrong (this fork has no SAS code; `AzureBlobProvider.signedUrl()` returns
null by design) — but the symptoms and crash mechanism were accurate.

## Actual root cause

1. `GET /api/single-documents/:documentId/url` falls back to
   `buildDownloadUrl()` (routes/documents.ts), which mints an HMAC download
   token via `getSecret()` in `lib/downloadTokens.ts`.
2. `getSecret()` deliberately throws when `NODE_ENV=production` and
   `DOWNLOAD_SIGNING_SECRET` is unset (fail-loud instead of signing with the
   forgeable dev fallback).
3. The deployment template set `NODE_ENV=production` but nothing ever
   provisioned `DOWNLOAD_SIGNING_SECRET` — not a Container App secretRef, not
   a Key Vault seed, not the install configurator. Every template-based
   install had this landmine.
4. The throw happened inside an `async` Express 4 handler. Express 4 does not
   catch async rejections and there was no process-level guard, so Node killed
   the container with exit 1. Container Apps restarted it; ingress served 503
   while no replica was up.
5. Sibling routes `/docx` and `/display` stream bytes via `downloadFile()`
   without minting a token — which is why only Download broke and storage
   looked healthy.

Chat-export links (`chatTools.ts`) and `/download/:token` verification mint or
verify tokens too, so they were the same landmine.

## Fix (three layers)

1. **Provision the secret** — `infra/modules/keyvault.bicep` seeds
   `download-signing-secret` (newGuid on first deploy; pass the existing KV
   value on redeploys or previously issued links stop validating — same
   contract as `mcp-connectors-encryption-key`). Compiles into the
   deployment template. Not in the installer's wipe list, so /install
   resets preserve it.
2. **Boot warm-up** — `initDownloadSigningSecret()` in `downloadTokens.ts`
   resolves the KV value into `process.env` before `app.listen()`
   (index.ts). No secretRef env wiring, per the redeploy-clobber rationale
   in 040 Entry 19.
3. **Process guards** — `lib/processGuards.ts` (installed first thing in
   index.ts): `unhandledRejection` logs and keeps serving, so no single
   request can take the process down; `uncaughtException` logs and exits.

Regression tests: `backend/src/lib/downloadTokens.test.ts` — including a
child-process test that fires the poison request at a guarded server with the
broken 1.0.9 env and asserts the process survives and keeps serving.

## Remediation for existing 1.0.9 installs

Setting a `DOWNLOAD_SIGNING_SECRET` env var (32+ random chars) directly on
the backend Container App stops the crash-loop — do this regardless, it's
the stability fix. (Older images lack the boot warm-up, so the env var is
the reliable route; writing KV alone won't help them.)

It does NOT make Download actually work on 1.0.9: that image (built
2026-05-22, commit `6824353`) predates `f5fb2f4` (2026-06-27), so the
frontend still assigns the relative `/download/<token>` path straight to
`a.href` — the request misses the `/api` prefix, falls through to the SPA
shell fallback, and the browser saves the HTML shell under the document's
filename (a "corrupt" download). In-app viewing (`/docx`, `/display`)
works throughout. Working downloads require upgrading to 1.0.10+.

## Follow-ups considered and skipped

- Health probes / minReplicas ≥ 2 (customer suggestion): masks crashes
  rather than fixing them; minReplicas 0 is a deliberate cost choice.
- Wrapping every async route in an error handler: Express 5 does this
  natively; revisit at the Express 5 upgrade instead of hand-wrapping ~100
  handlers.
