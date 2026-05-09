// /diag — operator diagnostic for Mike deployment configuration.
//
// Two endpoints:
//   GET /diag       — HTML shell; reads the JWT from the same localStorage
//                     key the frontend uses, then fetches /diag/data and
//                     renders the result. Returns a "please sign in" page
//                     when no token is stored.
//   GET /diag/data  — JSON. NO auth gate at all. If an Authorization
//                     header is present we try to validate the token and
//                     fold the principal + groups into the response;
//                     otherwise we return env-var status only. The route
//                     intentionally has no requireAuth / tenantAccess
//                     middleware because /diag is most useful BEFORE
//                     Entra is wired up, when the operator has nothing
//                     to sign in with yet.
//
// The page reflects back:
//  1. Env-var status — every env var the deploy needs, grouped by category,
//     with green tick / red cross / grey for required-but-missing /
//     optional-and-missing. Non-secret values are shown inline so an
//     operator can spot a typo (https// vs https://). Secrets only show
//     "set" or "not set".
//  2. Group OIDs from the JWT, with portal deep links and match status
//     against ENTRA_ADMIN_GROUP_IDS / ENTRA_MEMBER_GROUP_IDS.
//  3. The principal as the backend extracted it.
//  4. Raw JSON for reference.
//
// The page never reveals tenant data the operator does not already have
// access to via the portal Container App env-var table.

import { Router, Request, Response } from "express";
import type { AuthPrincipal } from "../lib/auth/types.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";

export const diagRouter = Router();

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface EnvVarDef {
  name: string;
  description: string;
  category: string;
  // "always": required in any deploy.
  // "entra": required only when AUTH_PROVIDER=entra.
  // "llm": part of the "at least one LLM key" group; individually optional
  //        but the page renders a roll-up at the top of the LLM section.
  // "optional": informational; never required.
  required: "always" | "entra" | "llm" | "optional";
  isSecret: boolean;
}

interface EnvVarStatus extends EnvVarDef {
  isSet: boolean;
  // What to show in the Value column. For non-secret env vars: the actual
  // value. For secrets: a partial reveal (first 6 + last 4 chars) when
  // long enough to be safe, "(set)" for short secrets, "(not set)" when
  // the env var is unset.
  display: string;
  // Status badge: "ok" (set + everything fine), "missing" (required but
  // not set), "optional" (not set + not required), "info" (set, but with
  // an inline note like "this is a fallback default").
  status: "ok" | "missing" | "optional";
}

interface DiagData {
  provider: string;
  envVars: EnvVarStatus[];
  // Roll-up for the "at least one LLM key" group: true if any of
  // ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, AZURE_OPENAI_API_KEY
  // is set.
  anyLlmKeySet: boolean;
  envAdminOids: string[];
  envMemberOids: string[];

  // Token-related fields. signedIn=false means the request had no valid
  // JWT and only the env-var checklist + env-var-derived rows are
  // populated. The page MUST still render usefully in this state since
  // /diag is most useful BEFORE Entra is wired up, when the operator
  // has nothing to sign in with yet.
  signedIn: boolean;
  authError?: string;
  principal?: AuthPrincipal;
  // For each OID in ENTRA_ADMIN_GROUP_IDS / ENTRA_MEMBER_GROUP_IDS, whether
  // the user's JWT groups claim contains it. Populated only when signedIn.
  adminMatches?: Array<{ oid: string; matched: boolean }>;
  memberMatches?: Array<{ oid: string; matched: boolean }>;
  // For each OID in the JWT, whether it is listed in either env var.
  // Populated only when signedIn.
  jwtGroupRoles?: Array<{ oid: string; role: "admin" | "member" | null }>;
  // Group claim overage. Populated only when signedIn.
  groupOverage?: boolean;
  // Useful for the suggested-fix prose: did the existing role resolution
  // produce any roles, or is the JWT failing to map. Populated only when
  // signedIn.
  resolvedRoles?: string[];
}

// Comprehensive list of env vars the deploy reads, in render order.
// Categories drive section grouping in the rendered page.
const ENV_VAR_DEFS: EnvVarDef[] = [
  // Auth core
  { name: "AUTH_PROVIDER", description: "Which auth provider validates JWTs (local | entra | supabase).", category: "Auth core", required: "always", isSecret: false },
  { name: "JWT_SECRET", description: "HMAC secret used by local-mode JWTs and to sign internal service-role JWTs for PostgREST.", category: "Auth core", required: "always", isSecret: true },
  { name: "SUPABASE_SECRET_KEY", description: "Same value as JWT_SECRET; the upstream code reads it under this name as well.", category: "Auth core", required: "always", isSecret: true },
  { name: "AUTH_STATE_SECRET", description: "HMAC secret used to sign /install session cookies. Required for /install/auth to work.", category: "Auth core", required: "always", isSecret: true },

  // Entra
  { name: "ENTRA_TENANT_ID", description: "Your Microsoft Entra directory tenant ID (UUID).", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_BACKEND_CLIENT_ID", description: "Client ID of the Backend API app registration.", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_BACKEND_SCOPE", description: "Full scope string the web client requests, of the form api://CLIENT_ID/access_as_user.", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_CLIENT_ID", description: "Client ID of the Web Login app registration.", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_CLIENT_SECRET", description: "Client secret on the Web Login app registration.", category: "Entra", required: "entra", isSecret: true },
  { name: "ENTRA_REDIRECT_URI", description: "OpenID redirect URI; must match the Web Login app reg exactly. Path is /api/auth/openid-callback/microsoft.", category: "Entra", required: "entra", isSecret: false },
  { name: "TENANT_ONBOARDING_MODE", description: "auto = first sign-in inserts a tenants row automatically; manual = denies until row exists.", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_ADMIN_GROUP_IDS", description: "Comma-separated Entra group OIDs whose members get the TenantAdmin role.", category: "Entra", required: "entra", isSecret: false },
  { name: "ENTRA_MEMBER_GROUP_IDS", description: "Comma-separated Entra group OIDs whose members get the Member role.", category: "Entra", required: "optional", isSecret: false },

  // Database
  { name: "DATABASE_URL", description: "Postgres connection string used by the schema-migration job. The Container App backend itself does not read this; the migration job does.", category: "Database", required: "optional", isSecret: true },
  { name: "PG_URI", description: "Same Postgres connection string, exposed to the postgrest sidecar via PGRST_DB_URI on the sidecar container.", category: "Database", required: "always", isSecret: true },
  { name: "SUPABASE_URL", description: "URL the backend uses to reach PostgREST. For the sidecar pattern this is http://localhost:3000.", category: "Database", required: "always", isSecret: false },

  // Storage
  { name: "AZURE_STORAGE_CONNECTION_STRING", description: "Azure Storage Account connection string, used to read/write blobs.", category: "Storage", required: "always", isSecret: true },
  { name: "AZURE_STORAGE_CONTAINER_NAME", description: "Name of the blob container holding documents.", category: "Storage", required: "always", isSecret: false },

  // Networking
  { name: "FRONTEND_URL", description: "Public URL of the application. Used for CORS allowlist and login redirects.", category: "Networking", required: "always", isSecret: false },
  { name: "BACKEND_PUBLIC_URL", description: "Public URL of the backend API. In a single-bundle deploy this is the same as FRONTEND_URL.", category: "Networking", required: "always", isSecret: false },
  { name: "NODE_ENV", description: "production | development. Affects cookie flags and a few defensive checks.", category: "Networking", required: "always", isSecret: false },
  { name: "PORT", description: "Port the Express backend listens on inside the container. Must match the Dockerfile EXPOSE and Container App ingress target port.", category: "Networking", required: "always", isSecret: false },

  // LLM keys (any one required)
  { name: "ANTHROPIC_API_KEY", description: "Anthropic API key. Either this or one of the other LLM keys is required.", category: "LLM", required: "llm", isSecret: true },
  { name: "OPENAI_API_KEY", description: "OpenAI API key.", category: "LLM", required: "llm", isSecret: true },
  { name: "GEMINI_API_KEY", description: "Google Gemini API key.", category: "LLM", required: "llm", isSecret: true },
  { name: "AZURE_OPENAI_API_KEY", description: "Azure OpenAI / Foundry API key.", category: "LLM", required: "llm", isSecret: true },

  // Azure OpenAI extras (optional)
  { name: "AZURE_OPENAI_ENDPOINT", description: "Azure OpenAI resource endpoint (https://<name>.openai.azure.com).", category: "LLM", required: "optional", isSecret: false },
  { name: "AZURE_OPENAI_DEPLOYMENT", description: "Default model deployment name.", category: "LLM", required: "optional", isSecret: false },
  { name: "AZURE_OPENAI_API_VERSION", description: "API version pinned for AOAI calls.", category: "LLM", required: "optional", isSecret: false },

  // Operator
  { name: "DOWNLOAD_SIGNING_SECRET", description: "HMAC key used to sign short-lived document download URLs.", category: "Operator", required: "always", isSecret: true },
  { name: "INSTALL_BOOTSTRAP_TOKEN", description: "One-time admin token for the /install configurator. Retired once an Entra admin signs in.", category: "Operator", required: "always", isSecret: true },

  // Optional / production hardening
  { name: "KEY_VAULT_NAME", description: "Name of the Key Vault used for KV-backed config. Required when /install needs to write config; not used in env-var-only minimal deploys.", category: "Optional", required: "optional", isSecret: false },
  { name: "AZURE_CLIENT_ID", description: "Client ID of the user-assigned Managed Identity attached to the Container App. Required for KV reads via MI.", category: "Optional", required: "optional", isSecret: false },
];

function maskSecret(value: string, isSet: boolean): string {
  if (!isSet) return "(not set)";
  if (value.length < 14) return "(set)";
  return value.slice(0, 6) + "..." + value.slice(-4);
}

function evaluateEnvVar(def: EnvVarDef, provider: string): EnvVarStatus {
  const raw = process.env[def.name];
  const isSet = raw !== undefined && raw !== "";
  let display: string;
  if (def.isSecret) {
    display = maskSecret(raw ?? "", isSet);
  } else {
    display = isSet ? (raw as string) : "(not set)";
  }

  let status: EnvVarStatus["status"];
  if (def.required === "always" && !isSet) status = "missing";
  else if (def.required === "entra" && provider === "entra" && !isSet) status = "missing";
  else if (!isSet) status = "optional";
  else status = "ok";

  return { ...def, isSet, display, status };
}

function buildEnvVarChecklist(provider: string): EnvVarStatus[] {
  return ENV_VAR_DEFS.map((def) => evaluateEnvVar(def, provider));
}

function buildDiagData(
  principal: AuthPrincipal | undefined,
  authError: string | undefined,
): DiagData {
  const provider = process.env.AUTH_PROVIDER ?? "supabase";
  const envVars = buildEnvVarChecklist(provider);
  const anyLlmKeySet = envVars
    .filter((e) => e.required === "llm")
    .some((e) => e.isSet);
  const envAdminOids = parseCsv(process.env.ENTRA_ADMIN_GROUP_IDS);
  const envMemberOids = parseCsv(process.env.ENTRA_MEMBER_GROUP_IDS);

  const base: DiagData = {
    provider,
    envVars,
    anyLlmKeySet,
    envAdminOids,
    envMemberOids,
    signedIn: false,
    authError,
  };

  if (!principal) return base;

  const jwtGroupSet = new Set(principal.groups);

  const adminMatches = envAdminOids.map((oid) => ({
    oid,
    matched: jwtGroupSet.has(oid),
  }));
  const memberMatches = envMemberOids.map((oid) => ({
    oid,
    matched: jwtGroupSet.has(oid),
  }));

  const adminSet = new Set(envAdminOids);
  const memberSet = new Set(envMemberOids);
  const jwtGroupRoles = principal.groups.map((oid) => ({
    oid,
    role: adminSet.has(oid)
      ? ("admin" as const)
      : memberSet.has(oid)
        ? ("member" as const)
        : null,
  }));

  // The group-overage detection lives in the Entra provider; if the
  // provider populated `principal.groups` as an empty array AND the
  // provider is "entra", the most likely cause is overage. We can not
  // distinguish "user has no groups" from "groups truncated due to
  // overage" without re-decoding the raw token here, which would
  // duplicate the provider's work; the heuristic is good enough for a
  // diagnostic surface.
  const groupOverage =
    provider === "entra" && principal.groups.length === 0;

  return {
    ...base,
    signedIn: true,
    principal,
    adminMatches,
    memberMatches,
    jwtGroupRoles,
    groupOverage,
    resolvedRoles: principal.roles,
  };
}

// Try to validate the bearer token if present. Returns the principal on
// success, an error message on failure, or { principal: undefined,
// error: undefined } when no Authorization header was sent. Does NOT
// write any HTTP response; the caller decides how to surface the result.
async function tryLoadPrincipal(
  req: Request,
): Promise<{ principal?: AuthPrincipal; error?: string }> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return {};
  const token = auth.slice(7).trim();
  if (!token) return {};

  const provider = process.env.AUTH_PROVIDER ?? "supabase";
  let result;
  if (provider === "supabase") result = await validateSupabaseToken(token);
  else if (provider === "local") result = await validateLocalToken(token);
  else if (provider === "entra") result = await validateEntraToken(token);
  else return { error: `Provider '${provider}' not supported` };

  if (!result.ok) return { error: result.detail };
  return { principal: result.principal };
}

diagRouter.get("/data", async (req: Request, res: Response) => {
  const { principal, error } = await tryLoadPrincipal(req);
  res.json(buildDiagData(principal, error));
});

function renderShell(): string {
  // Server-rendered shell. The body is filled in client-side by JS
  // that reads the access token from localStorage and calls /diag/data.
  // The JS includes both the Entra and local-mode storage keys so the
  // page works in either auth mode.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mike auth diagnostic</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 880px; margin: 2.5rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #656d76; margin: 2rem 0 0.6rem; }
  .sub { color: #656d76; margin-bottom: 1.75rem; font-size: 0.9rem; }
  .card { padding: 0.85rem 1rem; border: 1px solid #d0d7de; border-radius: 6px; background: white; margin-bottom: 0.6rem; }
  .card.green { background: #dafbe1; border-color: #6fdb7e; }
  .card.red { background: #fff5f5; border-color: #ffcecb; }
  .card.amber { background: #fff8c5; border-color: #d4a72c; }
  .row { display: grid; grid-template-columns: 200px 1fr; gap: 0.4rem 1rem; padding: 0.3rem 0; }
  .row .label { font-weight: 600; color: #57606a; font-size: 0.85rem; }
  .row .value { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.85rem; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #eaeef2; }
  th { font-weight: 600; color: #57606a; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td.oid { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.82rem; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  .badge.match { background: #dafbe1; color: #14532d; }
  .badge.miss { background: #fff5f5; color: #82071e; }
  .badge.admin { background: #ddf4ff; color: #1f3d59; }
  .badge.member { background: #eaeef2; color: #1f2328; }
  .badge.unmapped { background: #f6f8fa; color: #656d76; }
  a.btn { display: inline-block; padding: 0.3rem 0.7rem; border-radius: 6px; background: #1f6feb; color: white; font-weight: 600; font-size: 0.78rem; text-decoration: none; }
  a.btn:hover { background: #1a5fd0; }
  .copy-btn { background: #f6f8fa; color: #1f2328; border: 1px solid #d0d7de; padding: 0.25rem 0.6rem; border-radius: 6px; font-weight: 600; font-size: 0.75rem; cursor: pointer; }
  .copy-btn.ok { background: #dafbe1; border-color: #6fdb7e; color: #14532d; }
  pre.json { background: #f6f8fa; padding: 0.7rem 0.85rem; border-radius: 6px; font-size: 0.78rem; overflow-x: auto; max-height: 360px; line-height: 1.45; }
  .err { padding: 0.6rem 0.85rem; border-left: 3px solid #cf222e; background: #fff5f5; color: #82071e; font-size: 0.9rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; }
  .lead { padding: 0.7rem 0.9rem; background: #ddf4ff; border-left: 3px solid #1f6feb; font-size: 0.88rem; margin-bottom: 1.25rem; border-radius: 0 4px 4px 0; }
  .small { font-size: 0.78rem; color: #656d76; margin-top: 0.4rem; }
  .actions { margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
</head>
<body>
  <h1>Mike auth diagnostic</h1>
  <div class="sub">What does my JWT look like, and which group OID should I be using?</div>
  <div id="root">Loading diagnostic...</div>

<script>
(function () {
  const ENTRA_TOKEN_KEY = "mike.entra.access_token";
  const LOCAL_TOKEN_KEY = "mike.local.access_token";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readToken() {
    try {
      return (
        window.localStorage.getItem(ENTRA_TOKEN_KEY) ||
        window.localStorage.getItem(LOCAL_TOKEN_KEY) ||
        ""
      );
    } catch (e) {
      return "";
    }
  }

  function portalGroupLink(oid) {
    return (
      "https://portal.azure.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/" +
      encodeURIComponent(oid)
    );
  }

  function copyButton(value) {
    const id = "cb-" + Math.random().toString(36).slice(2, 9);
    return (
      '<button id="' +
      id +
      '" class="copy-btn" onclick="(function(btn,v){navigator.clipboard.writeText(v).then(function(){btn.classList.add(\\'ok\\');btn.textContent=\\'Copied\\';setTimeout(function(){btn.classList.remove(\\'ok\\');btn.textContent=\\'Copy\\';},1400);});})(this,' +
      JSON.stringify(value) +
      ')">Copy</button>'
    );
  }

  function notSignedInBanner() {
    return (
      '<div class="card amber" style="padding:0.7rem 0.95rem; margin-bottom:1rem; font-size:0.88rem;">' +
      '<strong>You are not signed in.</strong> The env-var checklist below shows the deploy configuration regardless. ' +
      'To also see your JWT principal, group memberships, and role mapping, sign in (locally if AUTH_PROVIDER=local, ' +
      'or via Microsoft once Entra is wired up) and reload this page.' +
      '</div>'
    );
  }

  function authErrorBanner(error) {
    return (
      '<div class="card red" style="padding:0.7rem 0.95rem; margin-bottom:1rem; font-size:0.88rem;">' +
      '<strong>Token rejected:</strong> ' + escapeHtml(error) + '. Sign in again, or check that the AUTH_PROVIDER value matches the kind of token you are presenting.' +
      '</div>'
    );
  }

  function principalCard(d) {
    const p = d.principal;
    return (
      '<h2>Sign-in</h2>' +
      '<div class="card">' +
      '<div class="row"><div class="label">Provider</div><div class="value">' +
      escapeHtml(d.provider) +
      "</div></div>" +
      '<div class="row"><div class="label">Tenant ID</div><div class="value">' +
      escapeHtml(p.tenantId || "(not set)") +
      "</div></div>" +
      '<div class="row"><div class="label">User ID (oid)</div><div class="value">' +
      escapeHtml(p.userId || "") +
      "</div></div>" +
      '<div class="row"><div class="label">Email</div><div class="value">' +
      escapeHtml(p.email || "(not in token)") +
      "</div></div>" +
      '<div class="row"><div class="label">Display name</div><div class="value">' +
      escapeHtml(p.displayName || "(not in token)") +
      "</div></div>" +
      '<div class="row"><div class="label">Resolved roles</div><div class="value">' +
      (d.resolvedRoles.length
        ? escapeHtml(d.resolvedRoles.join(", "))
        : '<span class="badge miss">none</span>') +
      "</div></div>" +
      "</div>"
    );
  }

  function jwtGroupsCard(d) {
    if (d.groupOverage) {
      return (
        '<h2>Groups in your JWT</h2>' +
        '<div class="card amber">Group claim overage detected. Your account is in too many groups for the JWT to carry the full list, so Entra emitted a Graph pointer instead. The application code does not currently follow the pointer; it sees an empty groups array and will deny access via GROUP_NOT_WHITELISTED. Workarounds: (a) put your account directly into a smaller dedicated security group used only for Mike admin, then point ENTRA_ADMIN_GROUP_IDS at that group, OR (b) implement Graph fallback in the auth provider to resolve overage tokens.</div>'
      );
    }
    if (d.principal.groups.length === 0) {
      return (
        '<h2>Groups in your JWT</h2>' +
        '<div class="card">JWT contains no groups claim. ' +
        (d.provider === "local"
          ? "AUTH_PROVIDER=local does not emit groups. Group-based role mapping only applies in Entra mode."
          : "Verify the Backend API app registration has Token configuration > groups claim enabled, with the right group-type filter (often \\"All groups\\" rather than \\"Security groups\\" only).") +
        "</div>"
      );
    }
    let body =
      '<h2>Groups in your JWT</h2>' +
      '<div class="card"><table><thead><tr><th>OID</th><th>Mapped role</th><th>Action</th></tr></thead><tbody>';
    for (const row of d.jwtGroupRoles) {
      const badge =
        row.role === "admin"
          ? '<span class="badge admin">admin</span>'
          : row.role === "member"
            ? '<span class="badge member">member</span>'
            : '<span class="badge unmapped">unmapped</span>';
      body +=
        "<tr>" +
        '<td class="oid">' +
        escapeHtml(row.oid) +
        "</td>" +
        "<td>" +
        badge +
        "</td>" +
        "<td>" +
        '<a class="btn" target="_blank" rel="noopener" href="' +
        escapeHtml(portalGroupLink(row.oid)) +
        '">Open in Entra</a> ' +
        copyButton(row.oid) +
        "</td>" +
        "</tr>";
    }
    body += "</tbody></table></div>";
    return body;
  }

  function envVarsCard(d) {
    function table(label, matches) {
      if (matches.length === 0) {
        return (
          '<div class="card"><strong>' +
          escapeHtml(label) +
          "</strong> is not set or empty.</div>"
        );
      }
      let html =
        '<div class="card"><strong>' +
        escapeHtml(label) +
        "</strong>" +
        '<table style="margin-top:0.4rem"><thead><tr><th>OID</th><th>Status</th><th>Action</th></tr></thead><tbody>';
      for (const row of matches) {
        const badge = row.matched
          ? '<span class="badge match">in your token</span>'
          : '<span class="badge miss">NOT in your token</span>';
        html +=
          "<tr>" +
          '<td class="oid">' +
          escapeHtml(row.oid) +
          "</td>" +
          "<td>" +
          badge +
          "</td>" +
          "<td>" +
          '<a class="btn" target="_blank" rel="noopener" href="' +
          escapeHtml(portalGroupLink(row.oid)) +
          '">Open in Entra</a></td>' +
          "</tr>";
      }
      html += "</tbody></table></div>";
      return html;
    }
    return (
      '<h2>Group ID env vars</h2>' +
      table("ENTRA_ADMIN_GROUP_IDS", d.adminMatches) +
      table("ENTRA_MEMBER_GROUP_IDS", d.memberMatches)
    );
  }

  function suggestedFix(d) {
    if (d.groupOverage) return "";
    if (d.resolvedRoles.length > 0) {
      return (
        '<h2>Status</h2>' +
        '<div class="card green">Your JWT maps to <strong>' +
        escapeHtml(d.resolvedRoles.join(", ")) +
        '</strong>. Group setup is correct; this user has access.</div>'
      );
    }
    if (d.principal.groups.length === 0) return "";
    const adminCsv = d.envAdminOids.join(",") || "(empty)";
    const firstOid = d.principal.groups[0];
    return (
      '<h2>Suggested fix</h2>' +
      '<div class="card red">No OID in ENTRA_ADMIN_GROUP_IDS or ENTRA_MEMBER_GROUP_IDS matches a group you are in. Pick the OID of the group whose members should be Mike admins, copy it from the table above, and update ENTRA_ADMIN_GROUP_IDS in the Container App backend container env vars.' +
      '<div class="small">Current ENTRA_ADMIN_GROUP_IDS: <code>' +
      escapeHtml(adminCsv) +
      "</code></div>" +
      '<div class="actions"><span class="small">Quick action:</span>' +
      copyButton(firstOid) +
      '<span class="small">copies the OID of the first group you are in (' +
      escapeHtml(firstOid) +
      ")</span></div>" +
      "</div>"
    );
  }

  function debugCard(d) {
    return (
      '<h2>Raw diagnostic data</h2>' +
      '<pre class="json">' +
      escapeHtml(JSON.stringify(d, null, 2)) +
      "</pre>"
    );
  }

  function envVarChecklistCard(d) {
    function badge(status) {
      if (status === "ok") return '<span class="badge match">set</span>';
      if (status === "missing") return '<span class="badge miss">MISSING</span>';
      return '<span class="badge unmapped">not set</span>';
    }
    function rowsForCategory(envVars, category) {
      const rows = envVars.filter(function (v) { return v.category === category; });
      if (rows.length === 0) return "";
      let body = '<h3 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.05em; color:#57606a; margin:1rem 0 0.4rem;">' + escapeHtml(category) + "</h3>";
      body += '<div class="card" style="padding:0;"><table>';
      body += '<thead><tr><th style="width:200px">Env var</th><th style="width:90px">Status</th><th>Value</th></tr></thead><tbody>';
      for (const row of rows) {
        const valueCell = row.status === "missing"
          ? '<span style="color:#cf222e; font-style:italic;">' + escapeHtml(row.display) + "</span>"
          : '<span style="font-family:ui-monospace,monospace; font-size:0.8rem; word-break:break-all;">' + escapeHtml(row.display) + "</span>";
        body += "<tr>"
          + '<td><div style="font-family:ui-monospace,monospace; font-size:0.82rem; font-weight:600;">' + escapeHtml(row.name) + "</div>"
          + '<div style="font-size:0.74rem; color:#656d76; margin-top:0.15rem; font-weight:400;">' + escapeHtml(row.description) + "</div></td>"
          + "<td>" + badge(row.status) + "</td>"
          + "<td>" + valueCell + "</td>"
          + "</tr>";
      }
      body += "</tbody></table></div>";
      return body;
    }

    const llmRollup = d.anyLlmKeySet
      ? '<div class="card green" style="padding:0.6rem 0.85rem; margin:0.4rem 0 0.6rem; font-size:0.85rem;">At least one LLM key is set, so model calls will succeed.</div>'
      : '<div class="card red" style="padding:0.6rem 0.85rem; margin:0.4rem 0 0.6rem; font-size:0.85rem;">No LLM key is set. The application will fail any model call until at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / AZURE_OPENAI_API_KEY is configured.</div>';

    const categories = ["Auth core", "Entra", "Database", "Storage", "Networking", "LLM", "Operator", "Optional"];
    let html = '<h2>Env var checklist</h2>';
    for (const cat of categories) {
      // Hide the Entra section entirely if AUTH_PROVIDER is not entra; keeps
      // the page short for local-mode operators.
      if (cat === "Entra" && d.provider !== "entra") continue;
      if (cat === "LLM") html += llmRollup;
      html += rowsForCategory(d.envVars, cat);
    }
    return html;
  }

  function render(d) {
    const root = document.getElementById("root");
    let html = '<div class="lead">This page reads the backend\\'s env vars (and your JWT, if you are signed in) and reflects the values back. Use it to confirm the deploy is wired up correctly without digging through the Container App env-var table. Secrets are masked; non-secrets are shown in full so you can spot a typo.</div>';
    if (d.authError) {
      html += authErrorBanner(d.authError);
    } else if (!d.signedIn) {
      html += notSignedInBanner();
    }
    html += envVarChecklistCard(d);
    if (d.signedIn) {
      html += jwtGroupsCard(d) + envVarsCard(d) + suggestedFix(d) + principalCard(d);
    }
    html += debugCard(d);
    root.innerHTML = html;
  }

  async function main() {
    // Token is optional. If present, /diag/data validates it and includes
    // principal + groups data. If absent, /diag/data returns env-var data
    // only and the page renders a "not signed in" banner.
    const token = readToken();
    const headers = token ? { Authorization: "Bearer " + token } : {};
    try {
      const response = await fetch("/diag/data", {
        headers: headers,
        credentials: "omit",
      });
      if (!response.ok) {
        const text = await response.text();
        document.getElementById("root").innerHTML =
          '<div class="err">/diag/data returned ' +
          response.status +
          ": " +
          escapeHtml(text) +
          "</div>";
        return;
      }
      const data = await response.json();
      render(data);
    } catch (e) {
      document.getElementById("root").innerHTML =
        '<div class="err">/diag/data fetch failed: ' +
        escapeHtml(e && e.message ? e.message : String(e)) +
        "</div>";
    }
  }

  main();
})();
</script>
</body>
</html>`;
  return html;
}

diagRouter.get("/", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderShell());
});
