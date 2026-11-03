#!/usr/bin/env node
// Single-install HTTP smoke. Drives an already-running API (and its upload
// worker) the way the browser does: health and runtime config, local sign-in,
// a project, an asynchronous document upload through an upload session (the
// worker claims it via claim_upload_processing_job), the processed document's
// listing and download, the inert pooled-only surfaces, and optionally one
// short chat turn.
//
//   SMOKE_API_URL=http://localhost:3001 node scripts/single-install-smoke.mjs
//
// The API must run with AUTH_PROVIDER=local and a nonproduction NODE_ENV,
// with Azure Blob storage (Azurite locally): upload-session verification needs
// the object's content type and ETag, which the filesystem driver does not
// report, so STORAGE_DRIVER=fs fails at verification (content_type_mismatch).
// Optional: SMOKE_EMAIL, SMOKE_UPLOAD_TIMEOUT_MS (default 120000),
// SMOKE_CHAT=1 (needs a provider key on the server), SMOKE_CHAT_MODEL.
// Exits non-zero on the first failed step; every step prints one line.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const api = new URL(process.env.SMOKE_API_URL || "http://localhost:3001");
if (!["localhost", "127.0.0.1", "[::1]"].includes(api.hostname))
  throw new Error("SMOKE_API_URL must target a loopback API");
const origin = api.origin;
const suffix = randomUUID().slice(0, 8);
const email = process.env.SMOKE_EMAIL || `single-smoke-${suffix}@example.test`;
const uploadTimeoutMs = Number(process.env.SMOKE_UPLOAD_TIMEOUT_MS) || 120_000;
const cookies = new Map();

function step(name, detail) {
  console.log(`ok   ${name}${detail ? ` - ${detail}` : ""}`);
}

async function call(path, init = {}) {
  const target = new URL(path, api);
  const headers = new Headers(init.headers);
  // The session cookie goes to the API only, never to a storage URL.
  if (target.origin === origin) {
    headers.set("Origin", origin);
    const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("Cookie", cookie);
  }
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    init = { ...init, body: JSON.stringify(init.json) };
  }
  const response = await fetch(target, { ...init, headers, redirect: "manual" });
  if (target.origin !== origin) return response;
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return response;
}

async function json(path, init, expected = 200) {
  const response = await call(path, init);
  const text = await response.text();
  assert.equal(response.status, expected, `${init?.method || "GET"} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** A minimal one-page PDF whose text the extractor can read back. */
function samplePdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const health = await json("/api/health");
assert.equal(health.ok, true);
step("health", "GET /api/health ok");

const config = await json("/config");
assert.equal(config.authProvider, "local", "the smoke needs AUTH_PROVIDER=local");
if ("tenancyMode" in config) assert.equal(config.tenancyMode, "single");
step("runtime config", `authProvider=${config.authProvider} tenancyMode=${config.tenancyMode ?? "(absent)"}`);

const install = await call("/install");
assert.notEqual(install.status, 404, "/install is pooled-only 404; a single install must serve it");
assert(install.status < 500, `/install -> ${install.status}`);
step("install surface", `GET /install -> ${install.status}`);

const login = await json("/api/auth/local-login", { method: "POST", json: { email } });
assert(login.user?.id, "local login returned no user");
const session = await json("/api/auth/session");
assert.equal(session.user?.id, login.user.id);
step("local sign-in", `user ${login.user.id}`);

const admin = await json("/api/tenant-admin/status");
assert.equal(admin.isTenantAdmin, false);
const overview = await call("/api/tenant-admin/overview");
assert.equal(overview.status, 403, `tenant-admin overview -> ${overview.status}`);
step("tenant admin inert", "status isTenantAdmin=false, overview 403");

const projectName = `Single smoke ${suffix}`;
const project = await json("/api/projects", { method: "POST", json: { name: projectName } }, 201);
assert(project.id);
step("create project", project.id);

const marker = `Single install smoke ${suffix}`;
const pdf = samplePdf(marker);
const filename = `single-smoke-${suffix}.pdf`;
const created = await json("/api/upload-sessions", {
  method: "POST",
  json: {
    purpose: "document_create",
    destination: { scope: "project", project_id: project.id },
    files: [{ client_id: "smoke-1", filename, size_bytes: pdf.length }],
  },
}, 201);
const sessionId = created.session.id;
const file = created.files[0];
assert(file?.upload, "upload session returned no upload descriptor");
if (file.upload.transport === "authenticated_parts") {
  // The part path is relative to the API base, like every apiRequest path.
  await json(`/api${file.upload.path}/0`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "X-Upload-Generation": file.upload.generation },
    body: pdf,
  });
} else {
  const put = await call(file.upload.url, { method: file.upload.method, headers: file.upload.headers, body: pdf });
  assert(put.ok, `storage PUT -> ${put.status} ${(await put.text()).slice(0, 200)}`);
}
const completed = await call(`/api/upload-sessions/${sessionId}/files/${file.id}/complete`, { method: "POST", json: { failed: false } });
assert(completed.status < 300, `complete -> ${completed.status} ${(await completed.text()).slice(0, 300)}`);
step("upload bytes", `${pdf.length} bytes via ${file.upload.transport || "direct"}, session ${sessionId}`);

const deadline = Date.now() + uploadTimeoutMs;
let polled;
let last = "";
for (;;) {
  polled = await json(`/api/upload-sessions/${sessionId}`);
  const current = polled.files.find((f) => f.id === file.id);
  last = `session=${polled.session.status} file=${current?.status} error=${current?.error_code ?? polled.session.error_code ?? "none"}`;
  if (current?.status === "completed" || current?.status === "error") break;
  if (Date.now() > deadline) assert.fail(`upload not processed within ${uploadTimeoutMs} ms: ${last}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const processed = polled.files.find((f) => f.id === file.id);
assert.equal(processed.status, "completed", `async upload processing failed: ${last}`);
step("async upload processing", last);

const listing = await json(`/api/projects/${project.id}/documents`);
const documents = Array.isArray(listing) ? listing : listing.documents ?? listing.items ?? [];
const document = documents.find((d) => d.filename === filename);
assert(document, `uploaded document missing from project listing (${documents.length} documents)`);
step("list documents", `${document.id} status=${document.status ?? "(n/a)"}`);

const download = await call(`/api/single-documents/${document.id}/file`);
assert.equal(download.status, 200, `download -> ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
assert(bytes.equals(pdf), `downloaded ${bytes.length} bytes differ from the ${pdf.length} uploaded`);
step("download", `${bytes.length} bytes, identical to the upload`);

if (process.env.SMOKE_CHAT === "1") {
  const response = await call("/api/chat", {
    method: "POST",
    json: {
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      ...(process.env.SMOKE_CHAT_MODEL ? { model: process.env.SMOKE_CHAT_MODEL } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `chat -> ${response.status} ${text.slice(0, 300)}`);
  assert(!/"type"\s*:\s*"error"/.test(text), `chat stream reported an error: ${text.slice(0, 400)}`);
  assert(/ready/i.test(text), `chat stream has no answer text: ${text.slice(0, 400)}`);
  step("chat", `${text.length} stream bytes, answer received`);
} else {
  console.log("skip chat - set SMOKE_CHAT=1 with a provider key on the server");
}

console.log("PASS single-install smoke");
