// /diag — operator diagnostic for Entra group setup.
//
// Two endpoints:
//   GET /diag       — HTML shell; reads the JWT from the same localStorage
//                     key the frontend uses, then fetches /diag/data and
//                     renders the result. Returns a "please sign in" page
//                     when no token is stored.
//   GET /diag/data  — JSON. Uses requireValidJwt (NOT requireAuth) so it
//                     bypasses the tenantAccess gate; the whole point of
//                     /diag is to help an operator who is signed in but
//                     blocked by GROUP_NOT_WHITELISTED to figure out which
//                     group OID to put in the env vars.
//
// The page never reveals tenant data; it only reflects back what the JWT
// already contains plus the values of two env vars
// (ENTRA_ADMIN_GROUP_IDS, ENTRA_MEMBER_GROUP_IDS) that an operator with
// access to the Container App config can already see in the portal.

import { Router, Request, Response } from "express";
import type { AuthPrincipal } from "../lib/auth/types.js";
import { requireValidJwt } from "../middleware/auth.js";

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

interface DiagData {
  provider: string;
  principal: AuthPrincipal;
  envAdminOids: string[];
  envMemberOids: string[];
  // For each OID in ENTRA_ADMIN_GROUP_IDS / ENTRA_MEMBER_GROUP_IDS, whether
  // the user's JWT groups claim contains it.
  adminMatches: Array<{ oid: string; matched: boolean }>;
  memberMatches: Array<{ oid: string; matched: boolean }>;
  // Same direction the other way: for each OID in the JWT, whether it is
  // listed in either env var. Useful when the operator wants to know which
  // of the user's groups is currently mapped.
  jwtGroupRoles: Array<{ oid: string; role: "admin" | "member" | null }>;
  // Group claim overage: when the user is in too many groups, Entra
  // truncates the groups claim to a Graph pointer. Surfaced here so the
  // operator knows the diag page can not see the full list.
  groupOverage: boolean;
  // Useful for the suggested-fix prose: did the existing role resolution
  // produce any roles, or is the JWT failing to map.
  resolvedRoles: string[];
}

function buildDiagData(principal: AuthPrincipal): DiagData {
  const provider = process.env.AUTH_PROVIDER ?? "supabase";
  const envAdminOids = parseCsv(process.env.ENTRA_ADMIN_GROUP_IDS);
  const envMemberOids = parseCsv(process.env.ENTRA_MEMBER_GROUP_IDS);
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
    provider,
    principal,
    envAdminOids,
    envMemberOids,
    adminMatches,
    memberMatches,
    jwtGroupRoles,
    groupOverage,
    resolvedRoles: principal.roles,
  };
}

diagRouter.get("/data", requireValidJwt, (_req: Request, res: Response) => {
  const principal = res.locals.principal as AuthPrincipal | undefined;
  if (!principal) {
    res.status(500).json({ detail: "Principal missing after auth" });
    return;
  }
  res.json(buildDiagData(principal));
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

  function noTokenView() {
    return (
      '<div class="err">No access token found in browser storage. Sign in to Mike first, then revisit this page.</div>' +
      '<a class="btn" href="/">Go to sign-in</a>'
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

  function render(d) {
    const root = document.getElementById("root");
    root.innerHTML =
      '<div class="lead">This page reads your JWT and reflects the values back so you can confirm group OIDs without decoding the token by hand. Group display names are NOT resolved here; click "Open in Entra" next to any OID to see the group name in the Azure portal.</div>' +
      principalCard(d) +
      jwtGroupsCard(d) +
      envVarsCard(d) +
      suggestedFix(d) +
      debugCard(d);
  }

  async function main() {
    const token = readToken();
    if (!token) {
      document.getElementById("root").innerHTML = noTokenView();
      return;
    }
    try {
      const response = await fetch("/diag/data", {
        headers: { Authorization: "Bearer " + token },
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
