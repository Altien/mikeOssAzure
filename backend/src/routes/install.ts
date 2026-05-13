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
    isInAdminGroup,
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
  .item { display: grid; grid-template-columns: auto 1fr auto; gap: 0.6rem 1rem; align-items: start; padding: 0.75rem 1rem; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 0.5rem; background: #ffffff; }
  .item.fail { background: #fff5f5; border-color: #ffcecb; }
  .item.info { background: #ddf4ff; border-color: #b6e3ff; }
  /* Advanced items are still rendered (the fix path is needed for OSS
     deployments / power users / break-glass), but visually de-emphasized
     so the marketplace happy path is obvious. See 036a Phase 6. */
  .item.advanced { opacity: 0.65; border-style: dashed; background: #fafbfc; }
  .item.advanced:hover, .item.advanced:focus-within { opacity: 1; }
  .item.advanced .label::after { content: "advanced"; display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.45rem; border-radius: 999px; background: #eaeef2; color: #57606a; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
  .item .badge { width: 1.5rem; height: 1.5rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: white; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; }
  .badge.pass { background: #1a7f37; }
  .badge.fail { background: #cf222e; }
  .badge.info { background: #1f6feb; }
  .item .label { font-weight: 600; font-size: 0.95rem; }
  .item .meta { font-size: 0.8rem; color: #656d76; margin-top: 0.15rem; }
  .item .detail { font-size: 0.8rem; color: #57606a; margin-top: 0.25rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
  .item .action { font-size: 0.8rem; color: #57606a; align-self: center; }
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
         placeholder="from Bicep deployment 'bootstrapToken' output">
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
    const single = `.\\${scriptName} ${filledArgs}`.trim();
    if (single.length <= 60) return single;
    // Split on space-then-hyphen so each `-FlagName value` chunk is its own line.
    const parts = filledArgs.split(/\s+(?=-)/g).filter(Boolean);
    return [`.\\${scriptName} \``, ...parts.map((p, i) => `  ${p}${i === parts.length - 1 ? "" : " `"}`)].join("\n");
}

function describeAction(item: EvaluatedItem, ctx: InstallContext): string {
    const fixedBy = item.fixedBy;
    // Group items are picker-only per issue 023.  The picker lives at the
    // standard /install/items/:id path so the rest of the renderer pipes
    // are unchanged.
    if (item.id === "entra-admin-group-id" || item.id === "entra-member-group-id") {
        const verb = item.result.status === "pass" ? "Change" : "Pick";
        return `<a class="btn" href="/install/items/${encodeURIComponent(item.id)}">${verb} group</a>`;
    }
    if (fixedBy.type === "auto") {
        return `<span class="pill">AUTO</span><div class="meta">${escape(fixedBy.description)}</div>`;
    }
    if (fixedBy.type === "in-app-form") {
        const verb = item.result.status === "pass" ? "Edit" : "Set";
        return `<a class="btn" href="/install/items/${encodeURIComponent(item.id)}">${verb}</a>`;
    }
    return `<a class="btn" href="/install/scripts/${encodeURIComponent(fixedBy.scriptName)}">Download ${escape(fixedBy.scriptName)}</a>`;
}

// Renders the second-row command + copy block for external-script items.
// Returns empty string for non-script items so the grid row collapses.
// Two overlapping rounded rectangles — the standard "copy" affordance
// across most modern UIs.  The label is sr-only so screen readers still
// announce "Copy" / "Copied".
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

function describeScriptCommand(item: EvaluatedItem, ctx: InstallContext): string {
    if (item.fixedBy.type !== "external-script") return "";
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

const SECTION_ORDER: ManifestSection[] = [
    "Foundations",
    "AI providers",
    "Entra ID",
    "Tenant policy",
    "Lifecycle",
];

function renderItem(item: EvaluatedItem, ctx: InstallContext): string {
    const { result } = item;
    const advancedClass = item.advanced ? " advanced" : "";
    return `
<div class="item ${result.status}${advancedClass}">
  <div class="badge ${result.status}" title="${escape(result.status)}">${result.status === "pass" ? "✓" : result.status === "fail" ? "!" : "i"}</div>
  <div>
    <div class="label">${escape(item.label)}${item.required ? "" : ' <span class="meta" style="font-weight:400">(optional)</span>'}</div>
    <div class="meta"><code>${escape(item.id)}</code> · ${escape(item.section)}</div>
    ${result.detail ? `<div class="detail">${escape(result.detail)}</div>` : ""}
  </div>
  <div class="action">${describeAction(item, ctx)}</div>
  ${describeScriptCommand(item, ctx)}
</div>`;
}

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
    const fails = items.filter((i) => i.result.status === "fail").length;
    const savedItem = savedItemId
        ? items.find((i) => i.id === savedItemId)
        : null;
    const sections = SECTION_ORDER.map((sec) => {
        const inSection = items.filter((i) => i.section === sec);
        if (inSection.length === 0) return "";
        return `<h2>${escape(sec)}</h2>\n${inSection.map((it) => renderItem(it, ctx)).join("\n")}`;
    }).join("\n");
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
<div class="sub">Signed in via ${escape(session.source)} — session expires in ${expiresIn} min. ${passes} passing, ${fails} failing.</div>
<div class="session">
  <span>Session source: <code>${escape(session.source)}</code></span>
  <form method="post" action="/install/sign-out">
    <button type="submit" class="secondary">Sign out</button>
  </form>
</div>
${savedItem ? `<div class="flash ok">Saved <code>${escape(savedItem.id)}</code> to Key Vault.${savedItem.requiresRevisionRestart === false ? "" : " A Container App revision restart is required for the new value to be picked up by the backend (see issue 023's secret-ref caveat)."}</div>` : ""}
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

async function buildContext(req: Request): Promise<InstallContext> {
    return {
        backendFqdn: req.hostname,
        keyVaultName: process.env.KEY_VAULT_NAME ?? "",
        resourceGroup: process.env.RESOURCE_GROUP ?? "",
        customFqdn: await readCustomFqdn(),
    };
}

installRouter.get("/", async (req: Request, res: Response) => {
    const session = res.locals.installSession as InstallSession | null;
    res.set("Content-Type", "text/html; charset=utf-8");
    if (!session) return void res.send(renderPasteForm());

    const ctx = await buildContext(req);
    const items = await evaluateManifest(ctx);
    const saved = typeof req.query.saved === "string" ? req.query.saved : null;
    res.send(renderChecklist(session, items, saved, ctx));
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
  Saving writes the value to your configured Key Vault.  If this secret
  is also wired as a Container App secret-ref env var, the running
  backend continues to serve the previously-cached value until the
  next revision restart.
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

<label for="picker-search" class="meta" style="display:block; margin-top:1rem;">Search the wider tenant (leave blank for groups you belong to):</label>
<input id="picker-search" type="text" placeholder="Type to search by display name" style="width:100%;" autocomplete="off">

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
  var searchEl   = document.getElementById("picker-search");
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
        html = '<em>No members returned.</em>';
      } else {
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

  async function loadDefault() {
    statusEl.textContent = "Loading your groups…";
    try {
      var data = await proxy("/install/groups/me-member-of");
      var sec = (data.value || []).filter(function(g) {
        return g.securityEnabled === true || g["@odata.type"] === "#microsoft.graph.group";
      });
      statusEl.textContent = sec.length + " group(s) you belong to. Type above to search the wider tenant.";
      populateSelect(sec);
      setSelected(null);
    } catch (e) { /* status set in proxy() */ }
  }

  var debounce = null;
  searchEl.addEventListener("input", function() {
    clearTimeout(debounce);
    var q = searchEl.value.trim();
    if (!q) { loadDefault(); return; }
    debounce = setTimeout(async function() {
      statusEl.textContent = "Searching…";
      try {
        var data = await proxy("/install/groups/search?q=" + encodeURIComponent(q));
        var groups = data.value || [];
        statusEl.textContent = groups.length + " match(es) for " + JSON.stringify(q);
        populateSelect(groups);
        setSelected(null);
      } catch (e) { /* status set */ }
    }, 250);
  });

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

    // Self-bootstrap fast-path: when entra-admin-group-ids is empty in KV
    // (fresh marketplace install, operator hasn't configured admin access
    // yet), allow the first user from the configured tenant through so
    // they can set the admin group from inside /install. Logged
    // prominently inside isSelfBootstrapAllowed(). The bootstrap-token
    // paste form remains available as the OSS / break-glass path. See
    // 036a Phase 5 / B1 decision.
    const selfBootstrap = await isSelfBootstrapAllowed(tid, principal);

    if (!selfBootstrap && !(await isInAdminGroup(groups))) {
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
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name}"`,
    );
    fs.createReadStream(target).pipe(res);
});
