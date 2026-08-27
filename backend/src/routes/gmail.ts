import crypto from "node:crypto";
import { Router } from "express";
import { checkProjectAccess } from "../lib/access";
import {
  completeGmailAuthorization,
  createGmailAuthorizationUrl,
  disconnectGmail,
  getGmailMessage,
  getGmailStatus,
  GmailError,
  importGmailMessage,
  searchGmailMessages,
} from "../lib/gmail";
import { createServerDatabase } from "../lib/database";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";

export const gmailRouter = Router();

function publicBackendUrl(req: import("express").Request): string {
  return (
    process.env.API_PUBLIC_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
}

function callbackUrl(req: import("express").Request): string {
  return (
    process.env.GMAIL_REDIRECT_URI?.trim() ||
    `${publicBackendUrl(req)}/integrations/gmail/oauth/callback`
  );
}

function popupHtml(
  payload: { success: boolean; detail?: string },
  nonce: string,
) {
  const frontend = (
    process.env.FRONTEND_URL ?? "http://localhost:3000"
  ).replace(/\/+$/, "");
  const origin = new URL(frontend).origin;
  const message = JSON.stringify({
    type: "gmail_oauth_result",
    ...payload,
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail authorization</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#111827;background:#f9fafb}main{max-width:360px;padding:24px;text-align:center}p{color:#6b7280}</style></head><body><main><h1>${payload.success ? "Gmail connected" : "Authorization failed"}</h1><p>${payload.success ? "You can return to Mike." : "Return to Mike and try connecting again."}</p></main><script nonce="${nonce}">const message=${message};if(window.opener&&!window.opener.closed){window.opener.postMessage(message,${JSON.stringify(origin)});}setTimeout(()=>window.close(),${payload.success ? 600 : 2500});</script></body></html>`;
}

function sendPopup(
  res: import("express").Response,
  payload: { success: boolean; detail?: string },
) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(popupHtml(payload, nonce));
}

function handleError(
  res: import("express").Response,
  error: unknown,
  context: string,
) {
  if (error instanceof GmailError) {
    return void res.status(error.status).json({ detail: error.message });
  }
  console.error(`[gmail] ${context} failed`, error);
  return void res.status(500).json({ detail: `${context} failed.` });
}

gmailRouter.get("/status", requireAuth, async (_req, res) => {
  try {
    res.json(await getGmailStatus(res.locals.userId as string));
  } catch (error) {
    handleError(res, error, "Gmail status lookup");
  }
});

gmailRouter.post(
  "/oauth/start",
  requireAuth,
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      const authorizationUrl = await createGmailAuthorizationUrl({
        userId: res.locals.userId as string,
        redirectUri: callbackUrl(req),
      });
      res.json({ authorizationUrl });
    } catch (error) {
      handleError(res, error, "Gmail authorization");
    }
  },
);

gmailRouter.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  if (oauthError || !code || !state) {
    return sendPopup(res.status(400), {
      success: false,
      detail: oauthError || "Missing OAuth callback parameters.",
    });
  }
  try {
    await completeGmailAuthorization({ code, state });
    sendPopup(res, { success: true });
  } catch (error) {
    console.error("[gmail] OAuth callback failed", error);
    sendPopup(res.status(400), {
      success: false,
      detail: error instanceof Error ? error.message : "Authorization failed.",
    });
  }
});

gmailRouter.delete(
  "/connection",
  requireAuth,
  requireMfaIfEnrolled,
  async (_req, res) => {
    try {
      await disconnectGmail(res.locals.userId as string);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, "Gmail disconnect");
    }
  },
);

gmailRouter.get("/messages", requireAuth, async (req, res) => {
  try {
    const maxResults = Number.parseInt(
      typeof req.query.maxResults === "string" ? req.query.maxResults : "25",
      10,
    );
    res.json(
      await searchGmailMessages({
        userId: res.locals.userId as string,
        query: typeof req.query.q === "string" ? req.query.q : "",
        maxResults: Number.isFinite(maxResults) ? maxResults : 25,
      }),
    );
  } catch (error) {
    handleError(res, error, "Gmail search");
  }
});

gmailRouter.get("/messages/:messageId", requireAuth, async (req, res) => {
  try {
    res.json(
      await getGmailMessage(res.locals.userId as string, req.params.messageId),
    );
  } catch (error) {
    handleError(res, error, "Gmail message lookup");
  }
});

gmailRouter.post("/import", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const messageId =
    typeof req.body?.messageId === "string" ? req.body.messageId : "";
  const projectId =
    typeof req.body?.projectId === "string" ? req.body.projectId : null;
  if (!messageId)
    return void res.status(400).json({ detail: "messageId is required" });
  const db = createServerDatabase();
  if (projectId) {
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
  }
  try {
    const result = await importGmailMessage({
      userId,
      messageId,
      projectId,
      db,
    });
    if (!result.ok)
      return void res.status(result.status).json({ detail: result.detail });
    res.status(201).json({ ...result.document, gmail: { messageId } });
  } catch (error) {
    handleError(res, error, "Gmail import");
  }
});
