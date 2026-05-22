// /install — first-time setup + ongoing-reconfiguration tool.
// See docs/issues/azure-migration/023-install-configurator.md.
//
// Slice 4 (this file) ships:
//   - GET  /install            — paste form OR placeholder checklist
//   - POST /install/auth       — bootstrap-token validation, issues session cookie
//   - POST /install/sign-out   — clears session cookie
//
// Slices 5+ replace the placeholder checklist with the manifest model.

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { getConfig, setConfig } from "../lib/config";
import { randomBytes } from "node:crypto";
import {
    clearInstallSession,
    isFirstVisitEligible,
    isInAdminGroup,
    isInitialAdmin,
    isSelfBootstrapAllowed,
    issueInstallSession,
    loadInstallSession,
    readIdTokenClaims,
    retireBootstrap,
    signOidcState,
    verifyOidcState,
    type InstallSession,
} from "../lib/install/installAuth";
import { resolveGroupNames, resolveUserGroups } from "../lib/install/userGroups";
import {
    clearSessionTokens,
    getSessionTokens,
    storeSessionTokens,
} from "../lib/install/sessionTokens";
import { evaluateManifest, findManifestItem } from "../lib/install/manifest";
import {
    type EvaluatedItem,
    type FormField,
    type InstallContext,
    type ManifestItem,
    type ManifestSection,
} from "../lib/install/types";

export const installRouter = Router();

installRouter.use(loadInstallSession);

function escape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function pageShell(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.04em; color: #656d76; margin: 2rem 0 0.75rem; }
  .sub { color: #656d76; margin-bottom: 2rem; font-size: 0.9rem; }
  form.inline { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-weight: 600; font-size: 0.9rem; }
  input[type=password], input[type=text], input[type=url], select { padding: 0.6rem 0.75rem; border: 1px solid #d0d7de; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.85rem; background: white; }
  button { padding: 0.55rem 1rem; border: 0; border-radius: 6px; background: #1f6feb; color: white; font-weight: 600; cursor: pointer; align-self: flex-start; }
  button.secondary { background: #f6f8fa; color: #1f2328; border: 1px solid #d0d7de; }
  .err { padding: 0.6rem 0.75rem; border-left: 3px solid #cf222e; background: #fff5f5; color: #82071e; font-size: 0.9rem; margin-bottom: 1rem; }
  .session { padding: 0.6rem 0.75rem; background: #ddf4ff; border-left: 3px solid #1f6feb; font-size: 0.85rem; margin-bottom: 1.25rem; display: flex; justify-content: space-between; align-items: center; }
  .session form { display: inline; }
  /* Progress banner — gap #32. Shown above the section list. */
  .install-progress { padding: 0.7rem 1rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .install-done { padding: 1rem 1.25rem; background: #dafbe1; border: 1px solid #6fdb7e; border-radius: 6px; margin-bottom: 1.5rem; }
  .install-done h2 { color: #1a7f37; }
  .install-done .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; color: white; text-decoration: none; font-weight: 600; }
  .section-intro { font-size: 0.85rem; color: #57606a; margin: 0.25rem 0 0.85rem 0; max-width: 50rem; line-height: 1.45; }
  .item { display: grid; grid-template-columns: auto 1fr; gap: 0.6rem 1rem; align-items: start; padding: 0.75rem 1rem; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 0.5rem; background: #ffffff; }
  .item.fail { background: #fff5f5; border-color: #ffcecb; }
  /* Optional rows that aren't set: same shape as fail but amber, not red.
     Operator's eye should distinguish "Mike is broken without this" from
     "Mike works fine without this." See 040 Entry 17. */
  .item.fail.optional-row { background: #fff8c5; border-color: #f0d77a; }
  .item.fail.optional-row .badge.fail { background: #9a6700; }
  /* Amber/yellow — operator-attention-required-but-not-broken. Used for
     'Users (who can use Mike)' when the default tenant-wide policy is in
     effect, and for verify-only failures (e.g. redirect-URI Graph
     propagation lag). Previous blue palette mapped 'info' to a neutral
     informational tone that didn't draw enough attention — operator on
     rg-mike-mtest2 2026-05-20 explicitly asked for yellow here. */
  .item.info { background: #fff8c5; border-color: #f0d77a; }
  /* Advanced items are still rendered (the fix path is needed for OSS
     deployments / power users / break-glass), but visually de-emphasized
     so the marketplace happy path is obvious. See 036a Phase 6. */
  .item.advanced { opacity: 0.65; border-style: dashed; background: #fafbfc; }
  .item.advanced:hover, .item.advanced:focus-within { opacity: 1; }
  .item.advanced .label::after { content: "advanced"; display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.45rem; border-radius: 999px; background: #eaeef2; color: #57606a; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
  .item .badge { width: 1.5rem; height: 1.5rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: white; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; }
  .badge.pass { background: #1a7f37; }
  .badge.fail { background: #cf222e; }
  .badge.info { background: #9a6700; }
  .item .label { font-weight: 600; font-size: 0.95rem; }
  .item .meta { font-size: 0.8rem; color: #656d76; margin-top: 0.15rem; }
  .item .detail { font-size: 0.8rem; color: #57606a; margin-top: 0.25rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
  .item .action { font-size: 0.8rem; color: #57606a; margin-top: 0.65rem; display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .item .action .pill { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; background: #eaeef2; color: #1f2328; font-weight: 600; font-size: 0.7rem; letter-spacing: 0.04em; }
  /* External-script items render an extra full-width row below the
     header cells, holding the multi-line command + Copy button. */
  .item .script-cmd { grid-column: 1 / -1; margin-top: 0.6rem; }
  .item .script-cmd-label { font-size: 0.78rem; color: #656d76; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.35rem; }
  .item .script-cmd-row { display: flex; gap: 0.5rem; align-items: stretch; }
  .item .script-cmd-row pre { flex: 1; margin: 0; background: #1f2328; color: #f6f8fa; padding: 0.6rem 0.85rem; border-radius: 6px; font-size: 0.78rem; overflow-x: auto; white-space: pre; line-height: 1.5; }
  .copy-btn { background: #f6f8fa; color: #1f2328; border: 1px solid #d0d7de; padding: 0 0.85rem; border-radius: 6px; font-weight: 600; font-size: 0.78rem; cursor: pointer; flex-shrink: 0; display: inline-flex; align-items: center; gap: 0.4rem; min-width: 2.5rem; justify-content: center; }
  .copy-btn svg { width: 16px; height: 16px; }
  .copy-btn.ok { background: #dafbe1; border-color: #6fdb7e; color: #1a7f37; }
  .copy-btn .copy-label { display: none; }
  a.btn { display: inline-block; padding: 0.4rem 0.85rem; border-radius: 6px; background: #1f6feb; color: white; font-weight: 600; font-size: 0.8rem; text-decoration: none; }
  a.btn.secondary { background: #f6f8fa; color: #1f2328; border: 1px solid #d0d7de; }
  .flash.ok { padding: 0.6rem 0.75rem; background: #dafbe1; border-left: 3px solid #1a7f37; color: #14532d; margin-bottom: 1rem; font-size: 0.9rem; }
  .restart-warn { font-size: 0.8rem; color: #9a6700; background: #fff8c5; border-left: 3px solid #d4a72c; padding: 0.5rem 0.75rem; margin-top: 0.5rem; border-radius: 0 4px 4px 0; }
  /* Pre-flight modal shown once per browser when the operator first
     visits the checklist with downloadable scripts in scope. */
  .modal-overlay { position: fixed; inset: 0; background: rgba(15,20,25,0.55); z-index: 100; display: none; align-items: center; justify-content: center; padding: 1rem; }
  .modal-overlay.show { display: flex; }
  .modal-card { background: white; max-width: 640px; width: 100%; border-radius: 10px; padding: 1.5rem 1.75rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); max-height: 90vh; overflow-y: auto; }
  .modal-card h2 { margin: 0 0 0.5rem; font-size: 1.2rem; text-transform: none; letter-spacing: 0; color: #1f2328; }
  .modal-card .lead { color: #57606a; margin: 0 0 1rem; font-size: 0.95rem; }
  .modal-card ul { margin: 0.5rem 0 1rem; padding-left: 1.25rem; font-size: 0.9rem; }
  .modal-card ul li { margin-bottom: 0.3rem; }
  .modal-card .acknowledge { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0; font-size: 0.9rem; }
  .modal-card .actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
  code { background: #f6f8fa; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.85em; }
  pre { background: #f6f8fa; padding: 0.5rem 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.78rem; margin: 0.4rem 0 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderPasteForm(error?: string): string {
    return pageShell(
        "Mike — Install",
        `
<h1>Mike installation</h1>
<div class="sub">First-time setup.  Paste the bootstrap token, or sign in with Microsoft if you've already configured Entra admin access.</div>
${error ? `<div class="err">${escape(error)}</div>` : ""}
<form class="inline" method="post" action="/install/auth" autocomplete="off">
  <label for="token">Bootstrap token</label>
  <input id="token" name="token" type="password" required autofocus
         placeholder="from Key Vault secret 'install-bootstrap-token'">
  <button type="submit">Continue with bootstrap</button>
</form>
<div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid #d0d7de;">
  <a class="btn secondary" href="/install/auth/microsoft/start">Sign in with Microsoft</a>
  <div class="meta" style="margin-top:0.4rem">
    Available once Entra apps are configured AND you're a member of the configured admin group.
  </div>
</div>
`,
    );
}

// Entry page shown when the admin group is not yet configured. The
// install URL is an unguessable Container Apps subdomain that only the
// buyer who deployed has seen, so we don't gate this behind a paste
// form — one-click through. Bootstrap-token paste stays available as
// a disclosure for OSS / break-glass use. See
// docs/issues/azure-migration/038-install-first-visit-bootstrap.md.
function renderFirstVisitEntry(): string {
    return pageShell(
        "Mike — Install",
        `
<h1>Mike installation</h1>
<div class="sub">First-time setup. Continue below to start configuring your install.</div>
<form class="inline" method="post" action="/install/first-visit" autocomplete="off">
  <button type="submit">Continue to setup</button>
</form>
<div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid #d0d7de;">
  <a class="btn secondary" href="/install/auth/microsoft/start">Sign in with Microsoft</a>
  <div class="meta" style="margin-top:0.4rem">
    Available once Entra apps are configured.
  </div>
</div>
<details style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid #d0d7de;">
  <summary style="cursor:pointer; font-size:0.85rem; color:#57606a;">Advanced: use bootstrap token instead</summary>
  <form class="inline" method="post" action="/install/auth" autocomplete="off" style="margin-top:0.75rem">
    <label for="token">Bootstrap token</label>
    <input id="token" name="token" type="password" required
           placeholder="from Key Vault secret 'install-bootstrap-token'">
    <button type="submit">Continue with bootstrap</button>
  </form>
  <div class="meta" style="margin-top:0.4rem">
    For OSS deployments or break-glass recovery. Read the token via
    <code>az keyvault secret show --vault-name &lt;your-kv&gt; --name install-bootstrap-token --query value -o tsv</code>.
  </div>
</details>
`,
    );
}

function fillArgs(template: string, ctx: InstallContext): string {
    // customFqdn (KV `custom-backend-fqdn`, edited from /install) takes
    // precedence over the host the operator reached /install on, so
    // command-lines reflect the chosen redirect-URI hostname even when
    // the custom domain isn't pointed at this app yet.
    const fqdn = ctx.customFqdn && ctx.customFqdn.trim()
        ? ctx.customFqdn.trim()
        : ctx.backendFqdn;
    return template
        .replace(/<kv>/g, ctx.keyVaultName)
        .replace(/<fqdn>/g, fqdn)
        .replace(/<rg>/g, ctx.resourceGroup);
}

// KV-backed override for `<fqdn>` script-arg substitution. Empty when
// unset or unreadable — fillArgs falls back to ctx.backendFqdn in that
// case.
async function readCustomFqdn(): Promise<string | undefined> {
    try {
        const v = await getConfig("custom-backend-fqdn");
        return v && v.trim() ? v.trim() : undefined;
    } catch {
        return undefined;
    }
}

// Format a `.ps1 -Arg val -Arg2 val` command for display.  PowerShell uses
// backtick (`) as the line-continuation token (NOT bash's backslash).
// Splits by " -" so each named arg lands on its own line; values stay
// glued to their flag.  If the whole thing fits in 60 chars we keep it
// on one line for readability.
function formatPowershellCommand(scriptName: string, filledArgs: string): string {
    // Two PowerShell traps the operator otherwise hits when running a
    // freshly-downloaded script:
    //
    //   1. Internet-zone Mark-of-the-Web — Windows refuses to load
    //      unsigned downloaded .ps1 files with SecurityError. Prefix
    //      `Unblock-File` so the operator's copy-paste handles it.
    //   2. Windows-PowerShell-5.1 (default file association for .ps1)
    //      chokes on UTF-8 em-dashes / fancy quotes in script comments
    //      even though the scripts themselves are PS-7-only via
    //      #requires. Forcing pwsh in the displayed command avoids the
    //      parser blowing up before it sees the #requires directive.
    //
    // See feedback_ps_scripts_pwsh_required memory for the full history.
    const unblock = `Unblock-File .\\${scriptName}`;
    const run = `pwsh -File .\\${scriptName} ${filledArgs}`.trim();
    if (run.length <= 60) return `${unblock}\n${run}`;
    // Split on space-then-hyphen so each `-FlagName value` chunk is its own line.
    const parts = filledArgs.split(/\s+(?=-)/g).filter(Boolean);
    const runMultiline = [`pwsh -File .\\${scriptName} \``, ...parts.map((p, i) => `  ${p}${i === parts.length - 1 ? "" : " `"}`)].join("\n");
    return `${unblock}\n${runMultiline}`;
}

// Returns the labels of rows this item depends on that haven't passed yet.
// Used to render "Waiting on: X" copy instead of an action button — stops
// operators clicking into a row whose required predecessor hasn't run.
// Closes 040 Entry 4 fix D.
function unmetRequires(item: EvaluatedItem, allItems: EvaluatedItem[]): EvaluatedItem[] {
    if (!item.requires || item.requires.length === 0) return [];
    return item.requires
        .map((id) => allItems.find((i) => i.id === id))
        .filter((dep): dep is EvaluatedItem => !!dep && dep.result.status !== "pass");
}

function describeAction(
    item: EvaluatedItem,
    ctx: InstallContext,
    allItems: EvaluatedItem[],
): string {
    const fixedBy = item.fixedBy;
    // Group items are picker-only per issue 023. The picker requires a
    // Graph access token, which only Entra-source sessions have — a
    // bootstrap-source session won't be able to drive the picker. Show
    // the operator the actual action they need ("Sign in with Microsoft
    // to pick a group") instead of letting them click through to a 403.
    // Closes 040 Entry 7 fix B.
    if (item.id === "entra-admin-group-id" || item.id === "entra-member-group-id") {
        if (ctx.sessionSource === "bootstrap") {
            return `<a class="btn" href="/install/auth/microsoft/start">Sign in with Microsoft to pick group</a>`;
        }
        const verb = item.result.status === "pass" ? "Change" : "Pick";
        return `<a class="btn" href="/install/items/${encodeURIComponent(item.id)}">${verb} group</a>`;
    }
    if (fixedBy.type === "auto") {
        return `<span class="pill">AUTO</span><div class="meta">${escape(fixedBy.description)}</div>`;
    }

    // Workflow gate: if any of this row's `requires:` haven't passed yet,
    // render a "Waiting on" hint instead of offering the action. Avoids
    // sending operators down a path that will fail (e.g. running
    // register-redirect-uris.ps1 before create-entra-apps.ps1).
    // Closes 040 Entry 4 fix D.
    const unmet = unmetRequires(item, allItems);
    if (unmet.length > 0 && item.result.status !== "pass") {
        const names = unmet.map((d) => escape(d.label)).join(", ");
        return `<span class="pill" style="background:#fff8c5;color:#9a6700">WAITING</span><div class="meta">Complete first: ${names}.</div>`;
    }

    if (fixedBy.type === "in-app-form") {
        // When alsoAsScript exists, the script is the recommended path
        // (the section intro usually calls it out as "recommended"). The
        // paste form becomes the secondary "I have a value already" path.
        // Verb flips accordingly. Closes 040 Entry 4 fix B.
        const hasScript = !!fixedBy.alsoAsScript;
        const verb = item.result.status === "pass" ? "Edit value" : (hasScript ? "Paste value" : "Set");
        const cls = hasScript ? "btn secondary" : "btn";
        return `<a class="${cls}" href="/install/items/${encodeURIComponent(item.id)}">${verb}</a>`;
    }
    const scriptMeta = getScriptMeta(fixedBy.scriptName);
    const metaBadge = scriptMeta && (scriptMeta.version || scriptMeta.lastModified)
        ? `<span class="meta" style="margin-left:0.5rem; font-size:0.7rem;">${
            scriptMeta.version ? `v${escape(scriptMeta.version)}` : ""
        }${
            scriptMeta.version && scriptMeta.lastModified ? " · " : ""
        }${
            scriptMeta.lastModified ? `as of ${escape(scriptMeta.lastModified.toISOString().slice(0, 10))}` : ""
        }</span>`
        : "";
    return `<a class="btn" href="/install/scripts/${encodeURIComponent(fixedBy.scriptName)}">Download ${escape(fixedBy.scriptName)}</a>${metaBadge}`;
}

// Renders the second-row command + copy block for external-script items.
// Returns empty string for non-script items so the grid row collapses.
// Two overlapping rounded rectangles — the standard "copy" affordance
// across most modern UIs.  The label is sr-only so screen readers still
// announce "Copy" / "Copied".
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

function renderScriptBlock(scriptName: string, argsTemplate: string, ctx: InstallContext): string {
    const filled = fillArgs(argsTemplate, ctx);
    const cmd = formatPowershellCommand(scriptName, filled);
    const dataCmd = JSON.stringify(cmd);
    const scriptMeta = getScriptMeta(scriptName);
    const metaBadge = scriptMeta && (scriptMeta.version || scriptMeta.lastModified)
        ? `<span class="meta" style="margin-left:0.5rem; font-size:0.7rem;">${
            scriptMeta.version ? `v${escape(scriptMeta.version)}` : ""
        }${
            scriptMeta.version && scriptMeta.lastModified ? " · " : ""
        }${
            scriptMeta.lastModified ? `as of ${escape(scriptMeta.lastModified.toISOString().slice(0, 10))}` : ""
        }</span>`
        : "";
    return `
<div class="script-cmd">
  <div class="script-cmd-label" style="display:flex; align-items:center; gap:0.5rem;">
    <a class="btn" href="/install/scripts/${encodeURIComponent(scriptName)}">Download ${escape(scriptName)}</a>
    ${metaBadge}
  </div>
  <div class="script-cmd-label" style="margin-top:0.5rem;">Run with (PowerShell):</div>
  <div class="script-cmd-row">
    <pre>${escape(cmd)}</pre>
    <button type="button" class="copy-btn" data-cmd='${escape(dataCmd)}' aria-label="Copy command to clipboard" title="Copy">
      ${COPY_ICON_SVG}
      <span class="copy-label">Copy</span>
    </button>
  </div>
</div>`;
}

function describeScriptCommand(item: EvaluatedItem, ctx: InstallContext, allItems: EvaluatedItem[]): string {
    // Don't render script affordances when the row is blocked by an unmet
    // require: — the operator would just hit "Run the prerequisite first."
    if (unmetRequires(item, allItems).length > 0 && item.result.status !== "pass") return "";

    // Don't render script affordances for "info"-state rows — info means
    // the check couldn't determine pass/fail (verify-access denied,
    // propagation lag, transient Graph error). The fix isn't usually
    // "run the script"; it's "refresh in a minute". Closes 040 Entry 6
    // fix A — script offer no longer renders for entra-frontend-
    // redirect-uris during the post-create-entra-apps propagation
    // window, where it was misleading.
    if (item.result.status === "info") return "";

    if (item.fixedBy.type === "external-script") {
        const filled = fillArgs(item.fixedBy.argsTemplate, ctx);
        const cmd = formatPowershellCommand(item.fixedBy.scriptName, filled);
        const dataCmd = JSON.stringify(cmd);
        return `
<div class="script-cmd">
  <div class="script-cmd-label">Run with (PowerShell):</div>
  <div class="script-cmd-row">
    <pre>${escape(cmd)}</pre>
    <button type="button" class="copy-btn" data-cmd='${escape(dataCmd)}' aria-label="Copy command to clipboard" title="Copy">
      ${COPY_ICON_SVG}
      <span class="copy-label">Copy</span>
    </button>
  </div>
</div>`;
    }

    // In-app-form rows with alsoAsScript: render the script as the
    // primary affordance directly on the checklist row. Previously the
    // script offer was buried behind the "Set" button, so operators who
    // didn't have a value to paste (the marketplace happy path) never
    // discovered it. Closes 040 Entry 4 fix A.
    //
    // Show the script regardless of THIS row's status — alsoAsScript
    // typically configures MULTIPLE rows (create-entra-apps.ps1 writes
    // tenant-id, both client-ids, and the frontend client secret in one
    // pass). When an upstream row passes (e.g. entra-tenant-id pre-seeded
    // by Bicep) but downstream rows still need the script, the offer
    // must remain visible. Idempotent scripts make a "still here as a
    // re-run affordance" appearance harmless even on fully-green rows.
    // Observed on rg-mike-mtest3 2026-05-22 where pre-seeding tenant-id
    // (040 Entry 21) hid the Entra setup script entirely.
    if (item.fixedBy.type === "in-app-form" && item.fixedBy.alsoAsScript) {
        return renderScriptBlock(
            item.fixedBy.alsoAsScript.scriptName,
            item.fixedBy.alsoAsScript.argsTemplate,
            ctx,
        );
    }

    return "";
}

const SECTION_ORDER: ManifestSection[] = [
    "Core setup",
    "AI providers",
    "Microsoft sign-in",
    "Access rules",
    "Cleanup",
];

function renderItem(item: EvaluatedItem, ctx: InstallContext, allItems: EvaluatedItem[]): string {
    const { result } = item;
    const advancedClass = item.advanced ? " advanced" : "";
    // Optional rows that are failing get amber treatment instead of red
    // (Mike works without them). 040 Entry 17 fix A.
    const optionalRowClass =
        !item.required && result.status === "fail" ? " optional-row" : "";
    return `
<div class="item ${result.status}${advancedClass}${optionalRowClass}">
  <div class="badge ${result.status}" title="${escape(result.status)}">${result.status === "pass" ? "✓" : result.status === "fail" ? "!" : "i"}</div>
  <div>
    <div class="label">${escape(item.label)}${item.required ? "" : ' <span class="meta" style="font-weight:400">(optional)</span>'}</div>
    <div class="meta"><code>${escape(item.id)}</code> · ${escape(item.section)}</div>
    ${result.detail ? `<div class="detail">${escape(result.detail)}</div>` : ""}
    <div class="action">${describeAction(item, ctx, allItems)}</div>
  </div>
  ${describeScriptCommand(item, ctx, allItems)}
</div>`;
}

// Plain-English intro for each section, shown above the rows. Helps
// non-engineer operators understand what they're configuring before
// they look at each row. See gap #32 in 036-marketplace-install-gaps.md.
const SECTION_INTROS: Record<ManifestSection, string> = {
    "Core setup":
        "Required Azure plumbing — the bits that should already be in place when you arrive here. If anything is red, the install template didn't finish cleanly.",
    "AI providers":
        "API keys for the AI models Mike will use. You only need one — pick whichever provider you have a key for. Multiple providers can coexist.",
    "Microsoft sign-in":
        "Wire Mike to your Microsoft organization so users can sign in with their work accounts. The recommended path is to run create-entra-apps.ps1 (offered on the first row) — it sets up everything in one go. The manual paste forms are for advanced operators with existing app registrations.",
    "Access rules":
        "Decide which Microsoft user groups can use Mike, and how new users from your organization are enrolled.",
    "Cleanup":
        "Final tidy-up after first-time setup is complete. Retiring the bootstrap token closes the first-time setup back-door; revoking installer access takes away the elevated permissions used during install.",
    "Optional":
        "Things that are nice to have but Mike will work without them.",
};

function renderChecklist(
    session: InstallSession,
    items: EvaluatedItem[],
    savedItemId: string | null,
    ctx: InstallContext,
): string {
    const expiresIn = Math.max(
        0,
        Math.round((session.expiresAt - Date.now()) / 60000),
    );
    const passes = items.filter((i) => i.result.status === "pass").length;
    // Split fails by required-ness so the banner can describe them
    // separately. Previously banner read 'Step 10 of 12 required ...
    // 4 rows need attention' which is mathematically inconsistent
    // (the 4 mixed required + optional fails). 040 Entry 17.
    const required = items.filter((i) => i.required);
    const optional = items.filter((i) => !i.required);
    const requiredPass = required.filter((i) => i.result.status === "pass").length;
    const requiredFails = required.filter((i) => i.result.status === "fail").length;
    const optionalFails = optional.filter((i) => i.result.status === "fail").length;
    const allRequiredPass = required.length > 0 && requiredPass === required.length;
    const savedItem = savedItemId
        ? items.find((i) => i.id === savedItemId)
        : null;
    const sections = SECTION_ORDER.map((sec) => {
        const inSection = items.filter((i) => i.section === sec);
        if (inSection.length === 0) return "";
        const intro = SECTION_INTROS[sec] ?? "";
        const introHtml = intro
            ? `<p class="section-intro">${escape(intro)}</p>\n`
            : "";
        return `<h2>${escape(sec)}</h2>\n${introHtml}${inSection.map((it) => renderItem(it, ctx, items)).join("\n")}`;
    }).join("\n");
    // Banner: progress at top + celebration when complete. Shown above
    // the existing session info / preflight modal.
    const progressBanner = allRequiredPass
        ? `<div class="install-done">
  <h2 style="margin:0 0 0.4rem 0">✓ Setup complete</h2>
  <p style="margin:0 0 0.6rem 0">All required items are green. Mike is ready for users.</p>
  <a class="btn" href="${escape(process.env.FRONTEND_URL ?? "/")}" style="background:#1a7f37">Go to Mike</a>
</div>`
        : `<div class="install-progress">
  <strong>Step ${requiredPass} of ${required.length}</strong> of required setup complete.
  ${requiredFails > 0 ? `<span style="color:#cf222e; margin-left:0.6rem">${requiredFails} required row${requiredFails === 1 ? "" : "s"} need${requiredFails === 1 ? "s" : ""} attention.</span>` : ""}
  ${optionalFails > 0 ? `<span style="color:#9a6700; margin-left:0.6rem">${optionalFails} optional row${optionalFails === 1 ? "" : "s"} unset.</span>` : ""}
</div>`;
    const hasScripts = items.some((i) => i.fixedBy.type === "external-script");
    return pageShell(
        "Mike — Install",
        `
<div class="modal-overlay" id="preflight-modal" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
  <div class="modal-card">
    <h2 id="preflight-title">Before you run install scripts</h2>
    <p class="lead">These PowerShell scripts make changes in <strong>your</strong> Microsoft Entra tenant and Azure subscription on your behalf:</p>
    <ul>
      <li>Create Microsoft Entra application registrations and mint a client secret</li>
      <li>Write secrets to your Key Vault (<code>${escape(process.env.KEY_VAULT_NAME ?? "")}</code>)</li>
      <li>Optionally provision Azure OpenAI / Foundry resources</li>
      <li>Grant or revoke role assignments on Key Vault</li>
    </ul>
    <p class="lead">Mike will only ever run these in your tenant with <em>your</em> credentials.  You are responsible for your Azure environment, so before running any of them:</p>
    <ul>
      <li>Open the <code>.ps1</code> file in an editor and read what it does — the scripts are short and idempotent.</li>
      <li>Have an Azure-fluent colleague review them if you're unsure.  Plain-language step descriptions live in the repo at <code>docs/install/scripts.md</code>.</li>
      <li>Keep a log of every command you run during install — useful for audit and for rolling back if needed.</li>
    </ul>
    <p class="lead">Each script needs:</p>
    <ul>
      <li>The Azure CLI installed locally and signed in with <code>az login</code></li>
      <li>Appropriate permissions in your tenant and subscription (Application Administrator for Entra app creation, Owner / Contributor on the resource group for AOAI, Key Vault Secrets Officer on the install Key Vault)</li>
    </ul>
    <p class="lead" style="margin-top:1rem">We surface this notice up front because Azure security is a shared responsibility — we want you to be confident the scripts do what we say they do before you run them.</p>
    <label class="acknowledge">
      <input type="checkbox" id="preflight-ack">
      I have read this and understand my responsibility for what runs in my Azure subscription.
    </label>
    <div class="actions">
      <button type="button" class="btn" id="preflight-ok" disabled style="background:#1f6feb; color:white; border:none; padding:0.55rem 1rem; border-radius:6px; opacity:0.5;">I understand</button>
    </div>
  </div>
</div>

<h1>Mike installation</h1>
<div class="sub">Signed in via ${escape(session.source)} — session expires in ${expiresIn} min. ${passes} passing, ${requiredFails + optionalFails} failing.</div>
<div class="session">
  <span>Session source: <code>${escape(session.source)}</code></span>
  <form method="post" action="/install/sign-out">
    <button type="submit" class="secondary">Sign out</button>
  </form>
</div>
${progressBanner}
${savedItem ? `<div class="flash ok">Saved <code>${escape(savedItem.id)}</code> to Key Vault.${savedItem.requiresRevisionRestart === false ? "" : " A Container App revision restart is required for the new value to be picked up by the backend (see issue 023's secret-ref caveat)."}</div>` : ""}
<div class="cta-row" style="margin: 0 0 1.5rem 0; padding: 0.7rem 1rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; font-size: 0.9rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
  <span>Want users to reach Mike on a friendly hostname like <code>mike.your-company.com</code>?</span>
  <a class="btn secondary" href="/install/custom-domain">Custom domain walkthrough →</a>
</div>
${sections}
<script>
(function() {
  // ── Pre-flight modal ─────────────────────────────────────────────
  var ACK_KEY = "mike.install.scripts-acknowledged";
  var modal = document.getElementById("preflight-modal");
  var ack = document.getElementById("preflight-ack");
  var ok = document.getElementById("preflight-ok");
  var hasScripts = ${hasScripts ? "true" : "false"};

  function alreadyAck() {
    try { return localStorage.getItem(ACK_KEY) === "1"; } catch (_) { return false; }
  }

  if (modal && hasScripts && !alreadyAck()) {
    modal.classList.add("show");
    ack.addEventListener("change", function() {
      ok.disabled = !ack.checked;
      ok.style.opacity = ack.checked ? "1" : "0.5";
    });
    ok.addEventListener("click", function() {
      if (ok.disabled) return;
      try { localStorage.setItem(ACK_KEY, "1"); } catch (_) { /* no-op */ }
      modal.classList.remove("show");
    });
  }

  // ── Copy buttons on script-command rows ───────────────────────────
  document.querySelectorAll(".copy-btn[data-cmd]").forEach(function(btn) {
    btn.addEventListener("click", async function() {
      var raw = btn.getAttribute("data-cmd") || "";
      var cmd = "";
      try { cmd = JSON.parse(raw); } catch (_) { cmd = raw; }
      try {
        await navigator.clipboard.writeText(cmd);
      } catch (_) {
        // Fallback: a transient textarea + execCommand for older browsers.
        var ta = document.createElement("textarea");
        ta.value = cmd;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
      }
      btn.classList.add("ok");
      btn.setAttribute("title", "Copied");
      var labelEl = btn.querySelector(".copy-label");
      var origLabel = labelEl ? labelEl.textContent : "Copy";
      if (labelEl) labelEl.textContent = "Copied";
      setTimeout(function() {
        btn.classList.remove("ok");
        btn.setAttribute("title", "Copy");
        if (labelEl) labelEl.textContent = origLabel;
      }, 1500);
    });
  });
})();
</script>
`,
    );
}

async function buildContext(req: Request, res?: Response): Promise<InstallContext> {
    const session = res?.locals.installSession as InstallSession | null | undefined;
    return {
        backendFqdn: req.hostname,
        keyVaultName: process.env.KEY_VAULT_NAME ?? "",
        resourceGroup: process.env.RESOURCE_GROUP ?? "",
        customFqdn: await readCustomFqdn(),
        sessionSource: session?.source,
    };
}

installRouter.get("/", async (req: Request, res: Response) => {
    const session = res.locals.installSession as InstallSession | null;
    res.set("Content-Type", "text/html; charset=utf-8");
    if (!session) {
        // While admin-group is unset, the gate is open — render the
        // one-click entry page. As soon as admin-group is configured,
        // future visitors see the paste form (or sign in via Microsoft).
        // See 038.
        if (await isFirstVisitEligible()) {
            return void res.send(renderFirstVisitEntry());
        }
        return void res.send(renderPasteForm());
    }

    const ctx = await buildContext(req, res);
    const items = await evaluateManifest(ctx);
    const saved = typeof req.query.saved === "string" ? req.query.saved : null;
    res.send(renderChecklist(session, items, saved, ctx));
});

// First-visit grant. Issues a bootstrap-source session without a token
// or sign-in, but ONLY while entra-admin-group-ids is empty in KV. Once
// the operator sets the admin group from inside the configurator, this
// route closes — subsequent requests hit the "not eligible" branch and
// the operator must use the bootstrap token or Microsoft sign-in.
//
// Every successful grant logs via console.warn for audit. See 038.
installRouter.post("/first-visit", async (req: Request, res: Response) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    if (!(await isFirstVisitEligible())) {
        res.status(403).send(
            renderPasteForm("Admin group is already configured. Sign in via Microsoft or use the bootstrap token."),
        );
        return;
    }
    const remote = req.ip ?? "unknown";
    const ua = req.get("user-agent") ?? "unknown";
    console.warn(
        "install.first_visit_granted",
        JSON.stringify({
            remote,
            ua,
            timestamp: new Date().toISOString(),
        }),
    );
    await issueInstallSession(res, "bootstrap");
    res.redirect("/install");
});

function requireSession(req: Request, res: Response): InstallSession | null {
    const session = res.locals.installSession as InstallSession | null;
    if (!session) {
        res.status(401).set("Content-Type", "text/html; charset=utf-8");
        res.send(renderPasteForm("Sign in with the bootstrap token first."));
        return null;
    }
    return session;
}

async function readCurrentValues(
    fields: FormField[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
        fields.map(async (f) => {
            try {
                const v = await getConfig(f.name);
                if (v) out.set(f.name, v);
            } catch {
                // Missing secret is fine — leave the field blank in the form.
            }
        }),
    );
    return out;
}

function renderField(f: FormField, existing: string): string {
    const pattern = f.pattern ? ` pattern="${escape(f.pattern)}"` : "";
    const required = f.required ? " required" : "";
    const placeholder = f.placeholder
        ? ` placeholder="${escape(f.placeholder)}"`
        : "";
    const isPassword = f.type === "password";

    // Don't echo password-typed secrets into HTML.  Surface only a
    // "currently set" hint so the operator can confirm there's an
    // existing value and decide whether to overwrite.  Other types
    // (text, url) are pre-filled so editing is a delta, not a
    // retype-from-memory.
    const valueAttr = !isPassword && existing
        ? ` value="${escape(existing)}"`
        : "";

    let input: string;
    if (f.options && f.options.length > 0) {
        const opts = f.options
            .map((opt) => {
                const sel = opt === existing ? " selected" : "";
                return `<option value="${escape(opt)}"${sel}>${escape(opt)}</option>`;
            })
            .join("");
        input = `<select id="f-${escape(f.name)}" name="${escape(f.name)}"${required}>
  ${existing ? "" : `<option value="">— pick —</option>`}
  ${opts}
</select>`;
    } else {
        input = `<input id="f-${escape(f.name)}" name="${escape(f.name)}" type="${escape(f.type)}"
         autocomplete="off"${required}${pattern}${placeholder}${valueAttr}>`;
    }

    const hint = (() => {
        if (!existing) return "";
        if (isPassword) {
            const tail = existing.length >= 4 ? existing.slice(-4) : existing;
            return `<div class="meta">Currently set (length=${existing.length}, ends in <code>…${escape(tail)}</code>).  Leave blank to keep the existing value.</div>`;
        }
        if (f.options) {
            return `<div class="meta">Currently <code>${escape(existing)}</code>.</div>`;
        }
        return `<div class="meta">Currently <code>${escape(existing)}</code>.  Edit above to change.</div>`;
    })();

    const help = f.helpText
        ? `<div class="meta" style="margin-top:0.3rem; line-height:1.45;">${escape(f.helpText)}</div>`
        : "";

    return `
  <label for="f-${escape(f.name)}">${escape(f.label)}</label>
  ${input}
  ${hint}
  ${help}`;
}

async function renderItemForm(
    item: ManifestItem,
    fields: FormField[],
    error: string | null,
): Promise<string> {
    const current = await readCurrentValues(fields);
    const inputs = fields
        .map((f) => renderField(f, current.get(f.name) ?? ""))
        .join("\n");

    // Optional companion script for items that also have a downloadable .ps1
    // path (e.g., AOAI, where the form covers connect-existing values and
    // the script covers provision-a-new-resource).
    let alsoAsScript = "";
    if (item.fixedBy.type === "in-app-form" && item.fixedBy.alsoAsScript) {
        const ctx: InstallContext = {
            backendFqdn: process.env.BACKEND_PUBLIC_URL?.replace(/^https?:\/\//, "") ?? "",
            keyVaultName: process.env.KEY_VAULT_NAME ?? "",
            resourceGroup: process.env.RESOURCE_GROUP ?? "",
            customFqdn: await readCustomFqdn(),
        };
        const tweaks = item.fixedBy.alsoAsScript.tweakOptions ?? [];
        // After server-side substitution, the template still has any
        // tweak placeholders (`<region>`, `<model>`, …).  Pre-substitute
        // their defaults for the initial render; the JS below rewrites
        // both the displayed pre and the clipboard payload on change.
        const partialTemplate = fillArgs(item.fixedBy.alsoAsScript.argsTemplate, ctx);
        let initialFilled = partialTemplate;
        for (const t of tweaks) {
            initialFilled = initialFilled.replace(
                new RegExp(`<${t.name}>`, "g"),
                t.defaultValue,
            );
        }
        const initialCmd = formatPowershellCommand(
            item.fixedBy.alsoAsScript.scriptName,
            initialFilled,
        );
        const tweakRow = tweaks.length === 0 ? "" : `
  <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.6rem;">
    ${tweaks.map((t) => `
      <label class="meta" style="display:flex; flex-direction:column; gap:0.2rem;">
        <span>${escape(t.label)}</span>
        <select class="tweak-select" data-tweak="${escape(t.name)}">
          ${t.options
              .map(
                  (opt) =>
                      `<option value="${escape(opt)}"${opt === t.defaultValue ? " selected" : ""}>${escape(opt)}</option>`,
              )
              .join("")}
        </select>
      </label>`).join("")}
  </div>`;
        alsoAsScript = `
<div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid #d0d7de;">
  <div class="meta" style="margin-bottom:0.6rem;">${escape(item.fixedBy.alsoAsScript.description)}</div>
  ${tweakRow}
  <a class="btn secondary" href="/install/scripts/${encodeURIComponent(item.fixedBy.alsoAsScript.scriptName)}" style="margin-bottom:0.6rem;">Download ${escape(item.fixedBy.alsoAsScript.scriptName)}</a>
  <div class="script-cmd-row">
    <pre id="aoai-cmd-pre" style="flex:1; margin:0; background:#1f2328; color:#f6f8fa; padding:0.6rem 0.85rem; border-radius:6px; font-size:0.78rem; overflow-x:auto; white-space:pre; line-height:1.5;">${escape(initialCmd)}</pre>
    <button id="aoai-copy-btn" type="button" class="copy-btn" aria-label="Copy command" title="Copy">
      ${COPY_ICON_SVG}
      <span class="copy-label">Copy</span>
    </button>
  </div>
</div>
<script>
(function() {
  var partial = ${JSON.stringify(partialTemplate)};
  var script = ${JSON.stringify(item.fixedBy.alsoAsScript.scriptName)};
  var pre = document.getElementById("aoai-cmd-pre");
  var btn = document.getElementById("aoai-copy-btn");
  var selects = document.querySelectorAll(".tweak-select[data-tweak]");

  function format(scriptName, filledArgs) {
    var single = "." + "\\\\" + scriptName + " " + filledArgs;
    if (single.length <= 60) return single;
    var parts = filledArgs.split(/\\s+(?=-)/g).filter(Boolean);
    if (parts.length <= 1) return single;
    var out = ["." + "\\\\" + scriptName + " \`"];
    for (var i = 0; i < parts.length; i++) {
      out.push("  " + parts[i] + (i === parts.length - 1 ? "" : " \`"));
    }
    return out.join("\\n");
  }

  function rebuild() {
    var filled = partial;
    selects.forEach(function(s) {
      var name = s.getAttribute("data-tweak") || "";
      filled = filled.split("<" + name + ">").join(s.value);
    });
    var cmd = format(script, filled);
    if (pre) pre.textContent = cmd;
    if (btn) btn.setAttribute("data-cmd", JSON.stringify(cmd));
  }
  rebuild();
  selects.forEach(function(s) { s.addEventListener("change", rebuild); });

  if (btn) {
    btn.addEventListener("click", async function() {
      var raw = btn.getAttribute("data-cmd") || "";
      var cmd = "";
      try { cmd = JSON.parse(raw); } catch (_) { cmd = raw; }
      try { await navigator.clipboard.writeText(cmd); } catch (_) {
        var ta = document.createElement("textarea");
        ta.value = cmd; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
      }
      btn.classList.add("ok");
      var l = btn.querySelector(".copy-label"); var o = l ? l.textContent : "";
      if (l) l.textContent = "Copied";
      setTimeout(function() { btn.classList.remove("ok"); if (l) l.textContent = o; }, 1500);
    });
  }
})();
</script>`;
    }

    return pageShell(
        `Mike — ${item.label}`,
        `
<h1>${escape(item.label)}</h1>
<div class="sub">Item <code>${escape(item.id)}</code> · ${escape(item.section)}</div>
${error ? `<div class="err">${escape(error)}</div>` : ""}
<form class="inline" method="post" action="/install/items/${encodeURIComponent(item.id)}" autocomplete="off">
${inputs}
  <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
    <button type="submit">Save to Key Vault</button>
    <a class="btn secondary" href="/install">Cancel</a>
  </div>
</form>
<div class="restart-warn">
  Saving stores the value in <code>${escape(process.env.KEY_VAULT_NAME ?? "your Key Vault")}</code>.
  Most settings take effect on the next request. A few (Container App
  env vars that secret-ref Key Vault) only refresh after the backend
  restarts — if a change doesn't seem to land, restart the backend
  Container App and refresh.
</div>
${alsoAsScript}
`,
    );
}

function validateField(
    field: FormField,
    value: string,
    hasExisting: boolean,
): string | null {
    const trimmed = value.trim();
    // "required" means the secret must end up populated — leaving the form
    // input blank when the secret is already set is a no-op, not a failure.
    if (field.required && !trimmed && !hasExisting) {
        return `${field.label} is required.`;
    }
    if (!trimmed) return null;
    if (field.pattern && !new RegExp(field.pattern).test(trimmed)) {
        return `${field.label} format check failed.`;
    }
    return null;
}

function renderGroupPicker(itemId: string, kind: "admin" | "member"): string {
    return pageShell(
        `Mike — pick ${kind} group`,
        `
<h1>Pick ${escape(kind)} group</h1>
<div class="sub">Item <code>${escape(itemId)}</code> · Tenant policy</div>

<div id="picker-status" class="meta" style="margin-top:1rem;">Loading your groups…</div>

<div class="meta" style="margin-top:1rem; padding:0.5rem 0.75rem; background:#fff8c5; border-left:3px solid #d4a72c; border-radius:0 4px 4px 0; font-size:0.85rem;">
  Only groups you're a member of are shown. This is deliberate: picking a group you're not in for the admin row would lock you out of the install on next sign-in. To use a group you're not currently in, add yourself to it in Entra ID first, then refresh.
</div>

<label for="picker-select" class="meta" style="display:block; margin-top:1rem;">Group:</label>
<select id="picker-select" style="width:100%; font-family:inherit; padding:0.4rem;">
  <option value="" disabled selected>— pick a group —</option>
</select>

<div id="picker-members" style="margin-top:1rem; padding:0.75rem 1rem; background:#f6f8fa; border:1px solid #d0d7de; border-radius:6px; font-size:0.9rem;">
  <strong id="picker-members-title">Members</strong>
  <div id="picker-members-body" class="meta" style="margin-top:0.5rem;">Pick a group above to preview its members.</div>
</div>

<form id="picker-form" method="post" action="/install/groups/save" style="margin-top:1rem;">
  <input type="hidden" name="type" value="${escape(kind)}">
  <input type="hidden" name="groupId" id="picker-group-id">
  <input type="hidden" name="displayName" id="picker-display-name">
  <button type="submit" class="btn" id="picker-use" disabled>Use this group</button>
  <a class="btn secondary" href="/install" style="margin-left:0.5rem;">Cancel</a>
</form>

<details id="picker-debug" open style="margin-top:1.5rem; padding:0.75rem 1rem; border:1px solid #d0d7de; border-radius:6px; background:#f6f8fa;">
  <summary style="cursor:pointer; font-weight:600; font-size:0.85rem;">Debug log (open by default — close once everything works)</summary>
  <pre id="picker-debug-log" style="margin:0.5rem 0 0; background:#1f2328; color:#f6f8fa; padding:0.6rem 0.85rem; border-radius:6px; font-size:0.75rem; line-height:1.5; max-height:24rem; overflow:auto; white-space:pre-wrap; word-break:break-all;"></pre>
</details>

<script>
(function() {
  var statusEl   = document.getElementById("picker-status");
  var selectEl   = document.getElementById("picker-select");
  var membersTitle = document.getElementById("picker-members-title");
  var membersBody  = document.getElementById("picker-members-body");
  var idEl   = document.getElementById("picker-group-id");
  var nameEl = document.getElementById("picker-display-name");
  var useBtn = document.getElementById("picker-use");
  var debugLog = document.getElementById("picker-debug-log");

  var groupsById = {};   // id -> { id, displayName, ... }
  var currentSelectedId = null;
  var currentMembersGroupId = null;
  var membersCache = {}; // id -> rendered HTML

  function log(label, value) {
    var ts = new Date().toISOString().slice(11, 23);
    var line = ts + "  " + label;
    if (value !== undefined) {
      line += ": " + (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    debugLog.textContent += line + "\\n";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // Backend proxy. The backend reads the Entra-source install session
  // cookie, looks up the cached Graph access token in-process, and
  // forwards the call to Microsoft Graph. The token never reaches the
  // browser. 401/403 here means the install session isn't Entra-source
  // or its cached token is missing — operator should sign in again.
  async function proxy(path) {
    log("GET", path);
    var resp;
    try {
      resp = await fetch(path, { headers: { Accept: "application/json" } });
    } catch (e) {
      log("fetch threw", String(e));
      statusEl.textContent = "Network error calling backend (see debug log).";
      throw e;
    }
    log("Response status", resp.status + " " + resp.statusText);
    var text = "";
    try { text = await resp.text(); } catch (_) { /* */ }
    log("Response body (raw)", text);
    if (!resp.ok) {
      var hint = "";
      if (resp.status === 401 || resp.status === 403) {
        hint = ' Try <a href="/install/auth/microsoft/start">signing in with Microsoft</a> from /install.';
      }
      statusEl.innerHTML = "Backend <strong>" + resp.status + "</strong> — see debug log." + hint;
      throw new Error("backend " + resp.status);
    }
    try { return JSON.parse(text); } catch (e) {
      log("JSON parse failed", String(e));
      throw e;
    }
  }

  function populateSelect(groups) {
    groupsById = {};
    selectEl.innerHTML = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = groups.length ? "— pick a group —" : "(no groups)";
    selectEl.appendChild(placeholder);
    // Sort by display name, case-insensitive.
    groups.slice().sort(function(a, b) {
      return (a.displayName || "").localeCompare(b.displayName || "", undefined, { sensitivity: "base" });
    }).forEach(function(g) {
      groupsById[g.id] = g;
      var opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.displayName || "(no name)";
      selectEl.appendChild(opt);
    });
  }

  function setSelected(id) {
    currentSelectedId = id;
    var g = groupsById[id];
    if (!g) {
      idEl.value = "";
      nameEl.value = "";
      useBtn.disabled = true;
      membersTitle.textContent = "Members";
      membersBody.textContent = "Pick a group above to preview its members.";
      return;
    }
    idEl.value = g.id;
    nameEl.value = g.displayName || "";
    useBtn.disabled = false;
    loadMembers(g);
  }

  async function loadMembers(g) {
    membersTitle.textContent = "Members of " + (g.displayName || "(no name)") + " — id: " + g.id;
    if (membersCache[g.id]) {
      membersBody.innerHTML = membersCache[g.id];
      return;
    }
    currentMembersGroupId = g.id;
    membersBody.textContent = "Loading…";
    try {
      var data = await proxy("/install/groups/" + encodeURIComponent(g.id) + "/members");
      if (currentMembersGroupId !== g.id) return; // stale — newer click took over
      log("Members raw .value (first 3)", (data.value || []).slice(0, 3));
      var members = (data.value || []).slice(0, 50);
      var html;
      if (!members.length) {
        // Empty group → block save. Picking a 0-member group renders
        // the app unusable: admin row empties admin role, member row
        // empties member role. Either way, no one (or only admin) can
        // use Mike. Closes 040 Entry 15 fix B.
        useBtn.disabled = true;
        useBtn.title = "This group has no members — pick another";
        html = '<em style="color:#cf222e;">This group has no members. Pick a different group, or add members in Entra ID first.</em>';
      } else {
        // Restore the button (loadMembers may have been called from
        // setSelected which already enabled it; we re-confirm here).
        useBtn.disabled = false;
        useBtn.title = "";
        html = members.map(function(m) {
          // Try every field Graph might use to identify the member.
          // displayName / userPrincipalName for users, mail for groups,
          // appDisplayName for service principals. Fall back to
          // @odata.type + id so the operator at least sees something.
          var name = m.displayName || m.appDisplayName || m.userPrincipalName || m.mail || "";
          if (!name) {
            var typeTag = (m["@odata.type"] || "?").replace("#microsoft.graph.", "");
            name = "[" + typeTag + " " + (m.id || "(no id)") + "]";
          }
          var subtitle = "";
          if (m.userPrincipalName && m.userPrincipalName !== name) subtitle = m.userPrincipalName;
          else if (m.mail && m.mail !== name) subtitle = m.mail;
          var subHtml = subtitle ? ' <span style="color:#666; font-size:0.85em">&lt;' + escapeHtml(subtitle) + '&gt;</span>' : '';
          return '<div style="padding:0.15rem 0">' + escapeHtml(name) + subHtml + '</div>';
        }).join("");
        if ((data.value || []).length >= 50) {
          html += '<div style="color:#666; margin-top:0.4rem; font-size:0.85em">(showing first 50)</div>';
        }
      }
      membersCache[g.id] = html;
      membersBody.innerHTML = html;
    } catch (err) {
      membersBody.textContent = "Failed to load members — see debug log.";
    }
  }

  selectEl.addEventListener("change", function() {
    setSelected(selectEl.value);
  });

  // Picker is restricted to groups the operator is a member of. The
  // tenant-wide search was removed because it lets the operator pick
  // a group they're NOT in, locking themselves out of their own
  // install on next sign-in (admin group GUID has to appear in the
  // operator's token group claim). Observed on rg-mike-mtest1
  // 2026-05-20. Closes 040 Entry 15 fix A.
  async function loadDefault() {
    statusEl.textContent = "Loading your groups…";
    try {
      var data = await proxy("/install/groups/me-member-of");
      // securityEnabled true ONLY. Earlier filter let any group through,
      // including M365 / distribution lists which are NOT in the token
      // groups claim (groupMembershipClaims SecurityGroup emits only
      // security groups). Picking a non-security group as admin would
      // lock the operator out. 040 Entry 15 fix recurrence.
      var sec = (data.value || []).filter(function(g) {
        return g.securityEnabled === true;
      });
      statusEl.textContent = sec.length + " security group(s) you belong to.";
      populateSelect(sec);
      setSelected(null);
    } catch (e) { /* status set in proxy() */ }
  }

  loadDefault();
})();
</script>
`,
    );
}

installRouter.get("/items/:id", async (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;
    const item = findManifestItem(req.params.id);
    if (!item) {
        res.status(404).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(pageShell("Not found", `<h1>Unknown manifest item: <code>${escape(req.params.id)}</code></h1><p><a href="/install">Back</a></p>`));
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    if (item.id === "entra-admin-group-id") {
        return void res.send(renderGroupPicker(item.id, "admin"));
    }
    if (item.id === "entra-member-group-id") {
        return void res.send(renderGroupPicker(item.id, "member"));
    }
    if (item.fixedBy.type !== "in-app-form") {
        res.status(400);
        return void res.send(pageShell("Not an in-app form", `<h1>${escape(item.label)} is not edited via /install</h1><p>Use the <code>${escape(item.fixedBy.type === "external-script" ? item.fixedBy.scriptName : "auto")}</code> path instead.</p><p><a href="/install">Back</a></p>`));
    }
    res.send(await renderItemForm(item, item.fixedBy.fields, null));
});

// Graph proxy for the picker. The picker page can't call Graph
// directly: the main app's MSAL token has audience=api://<backend>
// (it's a token *for* our backend, not Graph). We use the operator's
// /install Entra-session token instead, which IS Graph-scoped because
// /install/auth/microsoft/start requests Graph scopes alongside OIDC.
async function proxyGraph(
    req: Request,
    res: Response,
    graphUrl: string,
): Promise<void> {
    const session = requireSession(req, res);
    if (!session) return;
    if (session.source !== "entra" || !session.id) {
        return void res.status(403).json({
            detail:
                "The picker requires an Entra-source install session. " +
                "Sign in via 'Sign in with Microsoft' on /install.",
        });
    }
    const tokens = getSessionTokens(session.id);
    if (!tokens) {
        return void res.status(401).json({
            detail:
                "Session has no cached Graph token. Sign out and sign in " +
                "again — the operator's Graph access token is captured " +
                "during /install/auth/microsoft/callback.",
        });
    }

    let graphResp: globalThis.Response;
    try {
        graphResp = await fetch(graphUrl, {
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                Accept: "application/json",
            },
        });
    } catch (err) {
        return void res.status(502).json({
            detail: `Graph request failed: ${err instanceof Error ? err.message : String(err)}`,
        });
    }

    const text = await graphResp.text();
    res.status(graphResp.status).set("Content-Type", "application/json").send(text);
}

installRouter.get("/groups/me-member-of", async (req: Request, res: Response) => {
    const url =
        "https://graph.microsoft.com/v1.0/me/memberOf?" +
        "$select=id,displayName,securityEnabled&$top=50";
    await proxyGraph(req, res, url);
});

installRouter.get("/groups/search", async (req: Request, res: Response) => {
    const q = ((req.query.q as string | undefined) ?? "").trim();
    if (!q) return void res.status(400).json({ detail: "q is required" });
    if (!/^[\w \-_'.]+$/.test(q)) {
        return void res.status(400).json({ detail: "q has unsupported characters" });
    }
    // Escape single quotes for OData by doubling them.
    const safe = q.replace(/'/g, "''");
    const filter = `securityEnabled eq true and startswith(displayName,'${safe}')`;
    const url =
        "https://graph.microsoft.com/v1.0/groups?" +
        "$filter=" + encodeURIComponent(filter) +
        "&$select=id,displayName&$top=50";
    await proxyGraph(req, res, url);
});

installRouter.get("/groups/:groupId/members", async (req: Request, res: Response) => {
    const id = req.params.groupId;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return void res.status(400).json({ detail: "groupId is not a GUID" });
    }
    // No $select, no type cast — return whatever Graph gives us so the
    // picker can show real fields. $select on /members has bitten us:
    // /members is polymorphic over directoryObject, and projecting
    // user-derived fields like displayName has come back null in
    // practice even with the microsoft.graph.user type cast. Default
    // properties from Graph are sufficient for the picker.
    const url = `https://graph.microsoft.com/v1.0/groups/${id}/members?$top=50`;
    await proxyGraph(req, res, url);
});

installRouter.post("/groups/save", async (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;
    const body = (req.body ?? {}) as Record<string, string>;
    const kind = body.type;
    const groupId = (body.groupId ?? "").trim();
    const displayName = (body.displayName ?? "").trim();
    if (kind !== "admin" && kind !== "member") {
        return void res.status(400).json({ detail: "type must be admin or member" });
    }
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) {
        return void res.status(400).json({ detail: "groupId is not a GUID" });
    }
    const secretName = kind === "admin" ? "entra-admin-group-ids" : "entra-member-group-ids";
    const value = displayName ? `${groupId} # ${displayName}` : groupId;
    await setConfig(secretName, value);
    const itemId = kind === "admin" ? "entra-admin-group-id" : "entra-member-group-id";
    res.redirect(303, `/install?saved=${encodeURIComponent(itemId)}`);
});

installRouter.post("/items/:id", async (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;
    const item = findManifestItem(req.params.id);
    if (!item || item.fixedBy.type !== "in-app-form") {
        res.status(404).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(pageShell("Not found", `<h1>Unknown or non-form manifest item</h1><p><a href="/install">Back</a></p>`));
    }
    const fields = item.fixedBy.fields;
    const body = (req.body ?? {}) as Record<string, string>;
    const existing = await readCurrentValues(fields);

    for (const field of fields) {
        const err = validateField(
            field,
            body[field.name] ?? "",
            existing.has(field.name),
        );
        if (err) {
            res.status(400).set("Content-Type", "text/html; charset=utf-8");
            return void res.send(await renderItemForm(item, fields, err));
        }
    }

    try {
        for (const field of fields) {
            const value = (body[field.name] ?? "").trim();
            if (!value) continue; // blank = "keep existing"; skip the write
            await setConfig(field.name, value);
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(
            await renderItemForm(item, fields, `Save partially failed: ${detail}`),
        );
    }

    res.redirect(303, `/install?saved=${encodeURIComponent(item.id)}`);
});

installRouter.post("/auth", async (req: Request, res: Response) => {
    const presented = typeof req.body?.token === "string" ? req.body.token : "";
    if (!presented) {
        res.status(400).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(renderPasteForm("Token is required."));
    }

    let expected: string;
    try {
        expected = await getConfig("install-bootstrap-token");
    } catch (err) {
        const detail = err instanceof Error ? err.message : "Key Vault read failed";
        res.status(500).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(
            renderPasteForm(`Server could not read bootstrap token: ${detail}`),
        );
    }

    if (!expected) {
        res.status(503).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(
            renderPasteForm(
                "Bootstrap is no longer accepting tokens. The installer has already been retired; sign in via Microsoft instead.",
            ),
        );
    }

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
        res.status(401).set("Content-Type", "text/html; charset=utf-8");
        return void res.send(renderPasteForm("Token did not match."));
    }

    await issueInstallSession(res, "bootstrap");
    res.redirect(303, "/install");
});

installRouter.post("/sign-out", (req: Request, res: Response) => {
    const session = res.locals.installSession as InstallSession | null;
    if (session?.id) clearSessionTokens(session.id);
    clearInstallSession(res);
    res.redirect(303, "/install");
});

// Operator scripts shipped under /app/scripts/install in the Docker image.
// Allow only files matching a strict pattern so we never expose siblings
// of the scripts dir or anything outside it.
const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]+\.ps1$/;
const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts", "install");

// ── Entra OIDC for /install ───────────────────────────────────────────────
//
// The bootstrap path retires once the first Entra admin signs in here.  We
// reuse the existing frontend app reg's client-id/secret/tenant — the same
// values the main app uses — so no new registration is needed.  The flow:
//
//   1. GET /install/auth/microsoft/start
//        Generates state cookie, redirects to Entra authorize URL with
//        response_type=code and the redirect back to our /callback below.
//   2. GET /install/auth/microsoft/callback?code=&state=
//        Exchanges code for id_token + access_token, parses the user's
//        `groups` claim, checks against entra-admin-group-ids in KV, and
//        if matched: issues an Entra-source install session AND blanks
//        the bootstrap token.

const OIDC_STATE_COOKIE = "mike-install-oidc-state";

function backendBaseUrl(req: Request): string {
    const proto = req.protocol;
    const host = req.get("host") ?? req.hostname;
    return `${proto}://${host}`;
}

installRouter.get("/auth/microsoft/start", async (req: Request, res: Response) => {
    const tenantId = await getConfig("entra-tenant-id").catch(() => "");
    const clientId = await getConfig("entra-client-id").catch(() => "");
    if (!tenantId || !clientId) {
        return void res
            .status(503)
            .send(pageShell(
                "Entra not configured",
                `<h1>Entra ID not configured</h1>
                 <p>Run <code>create-entra-apps.ps1</code> first — Tenant or Frontend app id missing in Key Vault.</p>
                 <p><a class="btn" href="/install">Back</a></p>`,
            ));
    }

    const nonce = randomBytes(24).toString("hex");
    const state = await signOidcState({ nonce, issuedAt: Date.now() });
    res.cookie(OIDC_STATE_COOKIE, state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
        path: "/install/auth",
    });

    const redirect = `${backendBaseUrl(req)}/install/auth/microsoft/callback`;
    const authorize = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("response_mode", "query");
    authorize.searchParams.set("redirect_uri", redirect);
    // Graph scopes go into the same authorize call so the resulting
    // access_token is Graph-scoped (audience=graph.microsoft.com).
    // Without these the picker can't list groups; the token would have
    // audience=api://<backend> and Graph would 401 with
    // InvalidAuthenticationToken on every call.
    // User.ReadBasic.All is what makes /groups/{id}/members return real
    // displayName / userPrincipalName for OTHER users. Plain User.Read
    // only grants read of the signed-in user's own profile, which is
    // why the picker showed members as opaque [user <guid>] rows.
    authorize.searchParams.set(
        "scope",
        "openid profile email offline_access " +
            "https://graph.microsoft.com/User.Read " +
            "https://graph.microsoft.com/User.ReadBasic.All " +
            "https://graph.microsoft.com/GroupMember.Read.All " +
            "https://graph.microsoft.com/Group.Read.All",
    );
    authorize.searchParams.set("state", state);
    // prompt=login forces Entra to re-authenticate even if the user has
    // an active SSO session. select_account (the previous value) only
    // showed the account picker but could still return a cached
    // id_token — which carried stale group claims after we changed the
    // app reg's groupMembershipClaims config during install setup. For
    // the install flow specifically, the cost of re-entering credentials
    // is small (operator only signs in once or twice during setup), and
    // it eliminates an entire class of "I changed the config but the
    // token still shows the old state" failure mode. See gap #18 in
    // 036-marketplace-install-gaps.md.
    authorize.searchParams.set("prompt", "login");
    res.redirect(authorize.toString());
});

installRouter.get("/auth/microsoft/callback", async (req: Request, res: Response) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    if (typeof req.query.error === "string") {
        return void res
            .status(400)
            .send(pageShell(
                "Sign-in cancelled",
                `<h1>Sign-in cancelled</h1>
                 <p>${escape(String(req.query.error_description ?? req.query.error))}</p>
                 <p><a class="btn" href="/install">Back</a></p>`,
            ));
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const cookieState = (req as Request & { cookies?: Record<string, string> }).cookies?.[OIDC_STATE_COOKIE];
    const queryState = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !cookieState || cookieState !== queryState) {
        return void res
            .status(400)
            .send(pageShell(
                "Invalid callback",
                `<h1>OIDC state mismatch</h1>
                 <p>Try signing in again from <a href="/install">/install</a>.</p>`,
            ));
    }
    const verified = await verifyOidcState(cookieState);
    if (!verified) {
        return void res
            .status(400)
            .send(pageShell(
                "Invalid callback",
                `<h1>OIDC state expired or tampered</h1>
                 <p>Try signing in again from <a href="/install">/install</a>.</p>`,
            ));
    }

    const tenantId = await getConfig("entra-tenant-id");
    const clientId = await getConfig("entra-client-id");
    const clientSecret = await getConfig("entra-client-secret").catch(() => "");
    const redirect = `${backendBaseUrl(req)}/install/auth/microsoft/callback`;

    const tokenForm = new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        // Token endpoint scope must match what was requested at /authorize
        // — Entra returns invalid_grant if these drift. Keep these in sync
        // with /install/auth/microsoft/start.
        scope:
            "openid profile email offline_access " +
            "https://graph.microsoft.com/User.Read " +
            "https://graph.microsoft.com/GroupMember.Read.All " +
            "https://graph.microsoft.com/Group.Read.All",
    });
    if (clientSecret) tokenForm.set("client_secret", clientSecret);

    const tokenResp = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenForm,
        },
    );
    const tokenJson = (await tokenResp.json()) as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
    };
    if (!tokenResp.ok || !tokenJson.id_token) {
        return void res
            .status(400)
            .send(pageShell(
                "Token exchange failed",
                `<h1>Token exchange failed</h1>
                 <p>${escape(tokenJson.error_description ?? tokenJson.error ?? "(no detail)")}</p>
                 <p><a class="btn" href="/install">Back</a></p>`,
            ));
    }

    const claims = readIdTokenClaims(tokenJson.id_token);
    // resolveUserGroups handles the inline-claim case (most users) AND
    // the overage case where Entra has dropped `groups` from the token
    // and emitted `hasgroups: true` / `_claim_names` instead. In overage
    // it calls Microsoft Graph /me/memberOf using the access_token we
    // just received. Cached per (oid, iat) for 5 minutes. Returns []
    // on any failure — falls through to the admin gate which refuses.
    // See 036a Phase 7 (B4 reinterpreted as additive).
    const groups = await resolveUserGroups(claims, tokenJson.access_token);
    const principal = (claims?.preferred_username as string) ?? (claims?.email as string) ?? "(unknown)";
    const tid = typeof claims?.tid === "string" ? claims.tid : "";

    // Two escape hatches sit beside the normal admin-group gate:
    //   - selfBootstrap: when no admin group is configured yet (fresh
    //     install), allow the first tenant user through. 036a Phase 5.
    //   - initialAdmin: when the marketplace handshake (or deploy.ps1)
    //     captured the buyer's oid in KV, treat that user as a
    //     permanent admin — recovery from misconfigured-admin-group
    //     lockouts. 036a Phase 8 / gap #8.
    // Either passing skips the group check.
    const oidClaim = typeof claims?.oid === "string" ? claims.oid : "";
    const selfBootstrap = await isSelfBootstrapAllowed(tid, principal);
    const initialAdmin = await isInitialAdmin(oidClaim, principal);

    if (!selfBootstrap && !initialAdmin && !(await isInAdminGroup(groups))) {
        // Enrich the 403 with diagnostic data so the operator can
        // actually fix the situation rather than guessing.  See gap #7
        // in 036-marketplace-install-gaps.md.
        const oid = typeof claims?.oid === "string" ? claims.oid : "(unknown)";
        const rawAdminIds = (await getConfig("entra-admin-group-ids").catch(() => "")).trim();
        const configuredAdminGuids = rawAdminIds
            .split(",")
            .map((s) => s.split("#")[0].trim())
            .filter(Boolean);
        const adminNamesMap = await resolveGroupNames(configuredAdminGuids, tokenJson.access_token);
        const adminList = configuredAdminGuids.length === 0
            ? "<em>(none configured — should have hit the self-bootstrap path; this means the tenant claim didn't match)</em>"
            : configuredAdminGuids
                .map((g) => {
                    const name = adminNamesMap.get(g) ?? g;
                    return `<li><code>${escape(g)}</code>${name !== g ? ` — ${escape(name)}` : ""}</li>`;
                })
                .join("");
        const userGroupsList = groups.length === 0
            ? "<em>(empty — token carried no <code>groups</code> claim, and Graph fallback either wasn't triggered or returned nothing. Check that the access token has GroupMember.Read.All / Group.Read.All.)</em>"
            : groups.map((g) => `<li><code>${escape(g)}</code></li>`).join("");

        return void res
            .status(403)
            .send(pageShell(
                "Not an admin",
                `<h1>Sign-in succeeded but you're not in the admin group</h1>
                 <p>Signed in as <code>${escape(principal)}</code> (oid <code>${escape(oid)}</code>).</p>

                 <h2 style="font-size:1rem; margin-top:1.5rem;">Configured admin group(s)</h2>
                 ${configuredAdminGuids.length === 0 ? `<p>${adminList}</p>` : `<ul>${adminList}</ul>`}

                 <h2 style="font-size:1rem; margin-top:1.5rem;">Your group memberships (as the backend sees them)</h2>
                 ${groups.length === 0 ? `<p>${userGroupsList}</p>` : `<ul>${userGroupsList}</ul>`}

                 <h2 style="font-size:1rem; margin-top:1.5rem;">How to recover</h2>
                 <ul>
                   <li><strong>Add yourself to the configured admin group</strong> in Entra ID, then sign out everywhere and try again.</li>
                   <li><strong>Or change the configured admin group</strong> via the bootstrap-authed install path: read the bootstrap token from Key Vault with
                       <code>az keyvault secret show --vault-name &lt;kv&gt; --name install-bootstrap-token --query value -o tsv</code>,
                       paste it at <a href="/install">/install</a>, then update <code>entra-admin-group-ids</code>.</li>
                   <li><strong>Or — if no admin group is set at all</strong> — the install backend should have auto-allowed you via self-bootstrap. If you reached this page despite that, the token's <code>tid</code> claim didn't match <code>entra-tenant-id</code> in KV (sign-in came from a different Entra tenant than the one this install is configured for).</li>
                 </ul>

                 <p style="margin-top:1.5rem;"><a class="btn" href="/install">Back</a></p>`,
            ));
    }

    const session = await issueInstallSession(res, "entra");

    // Cache the operator's Graph access token + refresh token in-process,
    // keyed by session id, so the picker page can ask the backend to
    // proxy Graph calls instead of trying to use the main app's
    // backend-audience token directly. Tokens never travel back to the
    // browser.
    if (tokenJson.access_token) {
        const expiresInMs = (tokenJson.expires_in ?? 3600) * 1000;
        storeSessionTokens(session.id, {
            accessToken: tokenJson.access_token,
            refreshToken: tokenJson.refresh_token,
            expiresAt: Date.now() + expiresInMs,
            audience: "graph",
        });
    }

    res.clearCookie(OIDC_STATE_COOKIE, { path: "/install/auth" });
    // Auto-retire bootstrap on first successful Entra admin sign-in.
    try {
        const existing = await getConfig("install-bootstrap-token").catch(() => "");
        if (existing) await retireBootstrap();
    } catch {
        // Non-fatal: log and continue. The check still flips next render.
    }
    res.redirect(303, "/install");
});

installRouter.get("/scripts/:name", (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;
    const name = req.params.name;
    if (!SCRIPT_NAME_PATTERN.test(name)) {
        return void res.status(400).json({ detail: "Invalid script name." });
    }
    // Operator scripts (Entra app registration, AOAI provisioning, role
    // assignments) are not bundled with the application image by default —
    // operators drop their own .ps1 scripts into scripts/install/ at image
    // build time if they want them served here.  When the directory is
    // absent, the install configurator's "Download script" buttons degrade
    // cleanly rather than throw.
    if (!fs.existsSync(SCRIPTS_DIR)) {
        return void res.status(404).json({
            detail:
                "Operator scripts are not bundled with this deployment. " +
                "Add .ps1 files to scripts/install/ at image build time " +
                "to expose them via this route.",
        });
    }
    const target = path.join(SCRIPTS_DIR, name);
    if (!fs.existsSync(target)) {
        return void res.status(404).json({ detail: `Script not found: ${name}` });
    }
    // Surface script identity headers so operators can detect drift
    // between a local copy and the running backend's version. See
    // gap #11 in 036-marketplace-install-gaps.md.
    const stat = fs.statSync(target);
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    const version = readScriptVersion(target);
    if (version) res.setHeader("X-Script-Version", version);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name}"`,
    );
    fs.createReadStream(target).pipe(res);
});

// Pulls `# version: N` from the first ~10 lines of a script file. Empty
// string if not present. Read sync because we're already in a request
// handler that's synchronous for the existence/stat checks.
function readScriptVersion(filePath: string): string {
    try {
        const head = fs.readFileSync(filePath, { encoding: "utf-8" }).split(/\r?\n/, 10);
        for (const line of head) {
            const m = /^#\s*version:\s*(\S+)/.exec(line);
            if (m) return m[1];
        }
    } catch {
        // Unreadable file — header just isn't set
    }
    return "";
}

// Public-facing version of readScriptVersion, used by the manifest
// renderer to surface version + as-of-date next to each Download
// button. Returns null if the script doesn't exist or has no header.
export function getScriptMeta(scriptName: string): { version: string; lastModified: Date } | null {
    if (!SCRIPT_NAME_PATTERN.test(scriptName)) return null;
    if (!fs.existsSync(SCRIPTS_DIR)) return null;
    const target = path.join(SCRIPTS_DIR, scriptName);
    if (!fs.existsSync(target)) return null;
    return {
        version: readScriptVersion(target),
        lastModified: fs.statSync(target).mtime,
    };
}

// ── Custom-domain walkthrough ─────────────────────────────────────────────
//
// Static step-by-step guide for wiring a custom hostname (e.g. mike.altien.com)
// to the backend Container App. The full automated wizard from 036a Phase 11
// would orchestrate each step via ARM calls; this is the design contract
// it'd automate. For now operators copy commands from the page and run them
// locally — every command is pre-filled with the live values we can read
// (KV name, frontend app reg id, backend FQDN, resource group, env).
//
// Detects Cloudflare DNS by looking at the inbound Host header (if the
// operator reached /install via the custom domain already, we can sniff the
// upstream IP via x-forwarded-for; if it's a Cloudflare range, surface the
// orange-cloud caveat). Conservatively assumes "maybe Cloudflare" so the
// guidance shows regardless.
//
// See gap #19 in docs/issues/azure-migration/036-marketplace-install-gaps.md.

async function renderCustomDomainPage(
    session: InstallSession,
    backendHost: string,
): Promise<string> {
    const kvName = process.env.KEY_VAULT_NAME ?? "<your-kv>";
    const rgName = process.env.RESOURCE_GROUP ?? "<your-rg>";
    const subscriptionId = process.env.SUBSCRIPTION_ID ?? "<your-subscription-id>";
    const frontendClientId = (await getConfig("entra-client-id").catch(() => "")) || "<your-frontend-app-id>";
    // The Container App Environment name is conventionally `cae-mike-<env>`
    // where <env> is the suffix after `kv-mike-`. Derive defensively;
    // operator can override at any step.
    const envSuffix = kvName.replace(/^kv-mike-/, "") || "<env>";
    const caeName = `cae-mike-${envSuffix}`;
    const containerAppName = "backend";

    const body = `
<h1>Custom domain setup</h1>
<p class="lead" style="font-size:0.95rem; color:#444; max-width:50rem; line-height:1.5;">
  Use this walkthrough to point a friendly hostname (e.g. <code>mike.your-company.com</code>) at Mike's backend.
  Six steps, ~15-20 minutes of operator work spread across your DNS provider, the Azure CLI, and your Microsoft Entra app registration.
</p>

<div class="install-progress" style="margin-bottom:1.5rem">
  <strong>Public IP situation:</strong> Mike's backend already has a stable public address — <code>${escape(backendHost)}</code>.
  No new Public IP resource needs provisioning. The static IP that backs this hostname (<code>20.x.x.x</code> for Azure Container Apps environments)
  doesn't change across revisions, so it's safe to point DNS at it.
  Run <code>az containerapp env show --name ${escape(caeName)} --resource-group ${escape(rgName)} --query properties.staticIp -o tsv</code> to see the exact IP if you need an A-record.
</div>

<h2>Step 1 — Pick your hostname</h2>
<p class="section-intro">
  Decide what URL you want users to reach Mike on. For one customer install, something like <code>mike.your-company.com</code> is typical.
  You'll need control of the parent DNS zone (your-company.com) to add records.
</p>

<h2>Step 2 — Add DNS records at your provider</h2>
<p class="section-intro">
  Three records, all at the parent zone. Cloudflare, Route 53, GoDaddy, Namecheap all work — anywhere you manage DNS for the parent.
</p>

<div class="dns-records">
  <div class="dns-record">
    <div class="dns-record-title">Record 1 — Point your hostname at the backend</div>
    <table>
      <tr><th>Type</th><td>CNAME</td></tr>
      <tr><th>Name</th><td>your subdomain (e.g. <code>mike</code> if you want <code>mike.your-company.com</code>)</td></tr>
      <tr><th>Target</th><td><code>${escape(backendHost)}</code></td></tr>
      <tr><th>Proxy</th><td><em>See Cloudflare note below if applicable</em></td></tr>
    </table>
  </div>

  <div class="dns-record">
    <div class="dns-record-title">Record 2 — Prove you own the domain (Azure verification)</div>
    <p style="margin:0.4rem 0 0.6rem 0">First, run this to get the verification token:</p>
    <pre>az containerapp show --name ${escape(containerAppName)} \\
  --resource-group ${escape(rgName)} \\
  --query properties.customDomainVerificationId -o tsv</pre>
    <p style="margin:0.4rem 0 0.6rem 0">Then add this TXT record at your DNS provider (substitute the value from the command above):</p>
    <table>
      <tr><th>Type</th><td>TXT</td></tr>
      <tr><th>Name</th><td><code>asuid.&lt;your subdomain&gt;</code> (e.g. <code>asuid.mike</code>)</td></tr>
      <tr><th>Content</th><td>The verification ID from the <code>az</code> command above</td></tr>
      <tr><th>Proxy</th><td>N/A (TXT records aren't proxied)</td></tr>
    </table>
  </div>
</div>

<h3 style="font-size:1rem; margin-top:1rem;">⚠ Cloudflare-proxied? Read this</h3>
<p class="section-intro">
  If you set Record 1's proxy status to <strong>Proxied</strong> (orange cloud), Azure can't see the underlying CNAME and certificate
  provisioning will time out. The workaround is to flip the record to <strong>DNS-only</strong> (grey cloud) for the duration of cert
  provisioning (steps 3 and 4), then flip back to Proxied afterwards. Container Apps managed certs renew every ~3 months, so this
  flip will recur — for permanent Cloudflare-proxied mode, use Cloudflare's Origin Certificate (long-lived, bring-your-own) instead.
</p>

<h2>Step 3 — Register the hostname on the Container App</h2>
<p class="section-intro">Tells Azure to accept incoming requests on the new hostname. Idempotent — re-running with the same hostname is a no-op.</p>
<pre>az containerapp hostname add \\
  --hostname &lt;your-hostname&gt; \\
  --name ${escape(containerAppName)} \\
  --resource-group ${escape(rgName)}</pre>
<p class="section-intro" style="margin-top:0.5rem">
  Expected output: a JSON blob showing the hostname with <code>bindingType: "Disabled"</code> — that's fine, the cert binding comes in Step 4.
</p>

<h2>Step 4 — Provision the TLS certificate</h2>
<p class="section-intro">Azure generates a free managed cert via DNS validation. Pick CNAME validation (works through Cloudflare-grey or unproxied).</p>
<pre>az containerapp env certificate create \\
  --name ${escape(caeName)} \\
  --resource-group ${escape(rgName)} \\
  --certificate-name &lt;cert-name-of-your-choice&gt; \\
  --hostname &lt;your-hostname&gt; \\
  --validation-method CNAME</pre>
<p class="section-intro" style="margin-top:0.5rem">
  The command returns immediately with <code>provisioningState: "Pending"</code> and a validation token if needed. Cert issuance takes ~3-5 minutes.
  Poll status with:
</p>
<pre>az containerapp env certificate list \\
  --name ${escape(caeName)} --resource-group ${escape(rgName)} \\
  --query "[?name=='&lt;cert-name&gt;'].properties.provisioningState" -o tsv</pre>
<p class="section-intro" style="margin-top:0.5rem">Wait until it returns <code>Succeeded</code> before moving on.</p>

<h3 style="font-size:1rem; margin-top:1rem;">Then bind the cert to the hostname</h3>
<pre>az containerapp hostname bind \\
  --hostname &lt;your-hostname&gt; \\
  --name ${escape(containerAppName)} \\
  --resource-group ${escape(rgName)} \\
  --environment ${escape(caeName)} \\
  --certificate &lt;cert-name&gt;</pre>
<p class="section-intro" style="margin-top:0.5rem">
  Expected output: <code>bindingType: "SniEnabled"</code>. The hostname is now reachable at <code>https://&lt;your-hostname&gt;</code>.
</p>

<h2>Step 5 — Update Microsoft sign-in</h2>
<p class="section-intro">
  Add the new hostname to the frontend app registration's redirect URIs so Microsoft sign-in works on the custom domain.
  Two web redirects (install + main app callbacks) and one SPA redirect (login page).
</p>
<pre>$appId = "${escape(frontendClientId)}"
$host  = "&lt;your-hostname&gt;"

# Read current URIs (we merge, never overwrite)
$webNow = @(az ad app show --id $appId --query "web.redirectUris" -o tsv) -split "\`r?\`n" | Where-Object { $_ }
$spaNow = @(az ad app show --id $appId --query "spa.redirectUris" -o tsv) -split "\`r?\`n" | Where-Object { $_ }

# Add the new ones
$webNext = @($webNow + "https://$host/api/auth/openid-callback/microsoft" + "https://$host/install/auth/microsoft/callback" | Sort-Object -Unique)
$spaNext = @($spaNow + "https://$host/login" | Sort-Object -Unique)

az ad app update --id $appId --web-redirect-uris @webNext

# SPA needs Graph PATCH because az ad app update doesn't have --spa-redirect-uris yet
$objId = az ad app show --id $appId --query id -o tsv
$body = @{ spa = @{ redirectUris = $spaNext } } | ConvertTo-Json -Depth 4 -Compress
az rest --method patch \`
  --uri "https://graph.microsoft.com/v1.0/applications/$objId" \`
  --headers "Content-Type=application/json" \`
  --body $body</pre>

<h3 style="font-size:1rem; margin-top:1rem;">Update Container App's FRONTEND_URL env var</h3>
<p class="section-intro">So Mike's backend builds OAuth returnUrls pointing at the new hostname:</p>
<pre>az containerapp update --name ${escape(containerAppName)} --resource-group ${escape(rgName)} \\
  --set-env-vars FRONTEND_URL=https://&lt;your-hostname&gt;</pre>

<h2>Step 6 — Test</h2>
<p class="section-intro">
  Open <code>https://&lt;your-hostname&gt;/install</code> in a fresh InPrivate window. The page should load over TLS, and signing in via Microsoft should redirect back to the new hostname.
  If you see <code>AADSTS50011</code>, double-check Step 5 — a redirect URI is probably missing.
</p>

<div class="install-done" style="margin-top:2rem">
  <h2 style="margin:0 0 0.4rem 0">Done. Your custom domain is live.</h2>
  <p style="margin:0">
    If you flipped Cloudflare to grey-cloud in Step 2, flip it back to orange now. Mark your calendar
    for ~3 months from now — Container Apps managed certs auto-renew, and the renewal uses the same DNS validation, so you'll need to flip again briefly.
  </p>
</div>

<p style="margin-top:2rem"><a class="btn secondary" href="/install">← Back to install</a></p>
`;

    return pageShell("Mike — Custom domain setup", body) +
        `<style>
.dns-records { display: grid; gap: 1rem; margin: 1rem 0; }
.dns-record { padding: 0.85rem 1rem; border: 1px solid #d0d7de; border-radius: 6px; background: #fafbfc; }
.dns-record-title { font-weight: 600; margin-bottom: 0.5rem; }
.dns-record table { border-collapse: collapse; }
.dns-record th { text-align: left; padding: 0.2rem 0.6rem 0.2rem 0; font-weight: 600; font-size: 0.85rem; color: #57606a; vertical-align: top; }
.dns-record td { padding: 0.2rem 0; font-size: 0.9rem; }
.dns-record code, pre code { background: #eaeef2; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
pre { background: #1f2328; color: #f6f8fa; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; line-height: 1.5; }
pre code { background: transparent; color: inherit; padding: 0; }
</style>`;
}

installRouter.get("/custom-domain", async (req: Request, res: Response) => {
    const session = requireSession(req, res);
    if (!session) return;
    const backendHost = req.get("host") ?? "your-backend.azurecontainerapps.io";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(await renderCustomDomainPage(session, backendHost));
});
