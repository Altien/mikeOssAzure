import crypto from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { createDocumentFromBytes } from "./documentIngest";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";

type Db = ServerDatabase;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

type GmailConnectionRow = {
  user_id: string;
  email: string;
  encrypted_refresh_token: string;
  iv: string;
  auth_tag: string;
  scopes: string | string[] | null;
  created_at: string;
  updated_at: string;
};

type GmailOAuthStateRow = {
  id: string;
  user_id: string;
  redirect_uri: string;
  expires_at: string;
};

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};
type GmailApiMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  snippet: string;
  hasAttachments: boolean;
};

export type GmailMessageDetail = GmailMessageSummary & {
  cc: string;
  body: string;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
};

export class GmailError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "GmailError";
    this.status = status;
  }
}

export function ensureGmailSchema(): void {
  if (!databaseProviderIsSQLite()) return;
  getSqliteDb().exec(`
      create table if not exists gmail_connections (
        user_id text primary key,
        email text not null,
        encrypted_refresh_token text not null,
        iv text not null,
        auth_tag text not null,
        scopes text not null default '[]',
        created_at text not null,
        updated_at text not null
      );
      create table if not exists gmail_oauth_states (
        id text primary key,
        user_id text not null,
        redirect_uri text not null,
        expires_at text not null,
        created_at text not null
      );
      create index if not exists idx_gmail_oauth_states_expiry
        on gmail_oauth_states(expires_at);
    `);
}

export function isGmailConfigured(): boolean {
  return !!(
    process.env.GMAIL_CLIENT_ID?.trim() &&
    process.env.GMAIL_CLIENT_SECRET?.trim() &&
    process.env.USER_API_KEYS_ENCRYPTION_SECRET?.trim()
  );
}

function encryptionKey(): Buffer {
  const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw new GmailError(
      "USER_API_KEYS_ENCRYPTION_SECRET is required for Gmail integration.",
      503,
    );
  }
  return crypto.scryptSync(secret, "mike-gmail-oauth-v1", 32);
}

function encryptToken(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    encrypted_refresh_token: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptToken(row: GmailConnectionRow): string {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(row.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_refresh_token, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new GmailError(
      "The Gmail connection could not be decrypted. Reconnect Gmail.",
      409,
    );
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new GmailError("Google did not respond in time.", 504);
    }
    throw new GmailError("Could not reach Google.", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function googleJson<T>(
  url: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const record =
      body && typeof body === "object" ? (body as Record<string, any>) : {};
    const errorCode =
      typeof record.error === "string" ? record.error : record.error?.status;
    const detail =
      record.error?.message || record.error_description || errorCode;
    if (response.status === 400 && errorCode === "invalid_grant") {
      throw new GmailError(
        "The Gmail authorization expired. Reconnect Gmail.",
        401,
      );
    }
    throw new GmailError(
      typeof detail === "string"
        ? `${context}: ${detail}`
        : `${context} failed.`,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  return body as T;
}

async function profileEmailIntegrationEnabled(
  userId: string,
  db: Db,
): Promise<boolean> {
  const ensure = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId, email_integration_enabled: false },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (ensure.error) throw ensure.error;
  const { data, error } = await db
    .from("user_profiles")
    .select("email_integration_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const value = (data as { email_integration_enabled?: unknown } | null)
    ?.email_integration_enabled;
  return value === true || value === 1 || value === "1";
}

async function connectionRow(
  userId: string,
  db: Db,
): Promise<GmailConnectionRow | null> {
  ensureGmailSchema();
  const { data, error } = await db
    .from("gmail_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as GmailConnectionRow | null) ?? null;
}

export async function getGmailStatus(
  userId: string,
  db: Db = createServerDatabase(),
) {
  const available = isGmailConfigured();
  const enabled = await profileEmailIntegrationEnabled(userId, db);
  const connection = available ? await connectionRow(userId, db) : null;
  return {
    available,
    enabled,
    connected: !!connection,
    email: connection?.email ?? null,
  };
}

export async function gmailDeliveryAvailable(
  userId: string,
  db: Db = createServerDatabase(),
): Promise<boolean> {
  const status = await getGmailStatus(userId, db);
  return status.available && status.enabled && status.connected;
}

export async function createGmailAuthorizationUrl(params: {
  userId: string;
  redirectUri: string;
  db?: Db;
}): Promise<string> {
  if (!isGmailConfigured()) {
    throw new GmailError("Gmail is not configured on this instance.", 503);
  }
  const db = params.db ?? createServerDatabase();
  ensureGmailSchema();
  const state = crypto.randomBytes(32).toString("base64url");
  const stateId = crypto.createHash("sha256").update(state).digest("hex");
  const now = new Date();
  await db
    .from("gmail_oauth_states")
    .delete()
    .lt("expires_at", now.toISOString());
  const { error } = await db.from("gmail_oauth_states").insert({
    id: stateId,
    user_id: params.userId,
    redirect_uri: params.redirectUri,
    expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
    created_at: now.toISOString(),
  });
  if (error) throw error;

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", process.env.GMAIL_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function completeGmailAuthorization(params: {
  code: string;
  state: string;
  db?: Db;
}): Promise<{ userId: string; email: string }> {
  if (!isGmailConfigured()) {
    throw new GmailError("Gmail is not configured on this instance.", 503);
  }
  const db = params.db ?? createServerDatabase();
  ensureGmailSchema();
  const stateId = crypto
    .createHash("sha256")
    .update(params.state)
    .digest("hex");
  const { data, error } = await db
    .from("gmail_oauth_states")
    .select("*")
    .eq("id", stateId)
    .maybeSingle();
  if (error) throw error;
  const stateRow = data as GmailOAuthStateRow | null;
  if (!stateRow || Date.parse(stateRow.expires_at) <= Date.now()) {
    if (stateRow)
      await db.from("gmail_oauth_states").delete().eq("id", stateId);
    throw new GmailError(
      "The Gmail authorization request expired. Try again.",
      400,
    );
  }
  await db.from("gmail_oauth_states").delete().eq("id", stateId);

  const token = await googleJson<{
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  }>(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.code,
        client_id: process.env.GMAIL_CLIENT_ID!.trim(),
        client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(),
        redirect_uri: stateRow.redirect_uri,
        grant_type: "authorization_code",
      }),
    },
    "Google authorization",
  );
  if (!token.access_token || !token.refresh_token) {
    throw new GmailError(
      "Google did not return an offline refresh token. Reconnect and grant access.",
      400,
    );
  }
  const grantedScopes = token.scope?.split(/\s+/).filter(Boolean);
  if (
    grantedScopes &&
    GMAIL_SCOPES.some((scope) => !grantedScopes.includes(scope))
  ) {
    throw new GmailError(
      "Gmail read and send permissions are both required. Reconnect and grant both permissions.",
      400,
    );
  }
  const profile = await googleJson<{ emailAddress?: string }>(
    `${GMAIL_API_URL}/users/me/profile`,
    { headers: { Authorization: `Bearer ${token.access_token}` } },
    "Gmail profile lookup",
  );
  if (!profile.emailAddress) {
    throw new GmailError("Google did not return the Gmail address.", 502);
  }

  const now = new Date().toISOString();
  const { error: saveError } = await db.from("gmail_connections").upsert(
    {
      user_id: stateRow.user_id,
      email: profile.emailAddress,
      ...encryptToken(token.refresh_token),
      scopes: grantedScopes ?? GMAIL_SCOPES,
      created_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (saveError) throw saveError;
  return { userId: stateRow.user_id, email: profile.emailAddress };
}

export async function disconnectGmail(
  userId: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  ensureGmailSchema();
  const { error } = await db
    .from("gmail_connections")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}

async function accessToken(userId: string, db: Db): Promise<string> {
  if (!isGmailConfigured()) {
    throw new GmailError("Gmail is not configured on this instance.", 503);
  }
  if (!(await profileEmailIntegrationEnabled(userId, db))) {
    throw new GmailError(
      "Email Integration is disabled in account features.",
      403,
    );
  }
  const connection = await connectionRow(userId, db);
  if (!connection)
    throw new GmailError("Connect Gmail before using email integration.", 409);
  const token = await googleJson<{ access_token?: string }>(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID!.trim(),
        client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(),
        refresh_token: decryptToken(connection),
        grant_type: "refresh_token",
      }),
    },
    "Gmail token refresh",
  );
  if (!token.access_token)
    throw new GmailError("Google did not return an access token.", 502);
  return token.access_token;
}

function header(message: GmailApiMessage, name: string): string {
  return (
    message.payload?.headers
      ?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value?.trim() ?? ""
  );
}

function decodeBase64Url(value: string): string {
  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function allParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(allParts)];
}

function summarize(message: GmailApiMessage): GmailMessageSummary {
  const parts = allParts(message.payload);
  const rawDate = header(message, "Date");
  const parsedDate = rawDate ? new Date(rawDate) : null;
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    subject: header(message, "Subject") || "(No subject)",
    from: header(message, "From"),
    to: header(message, "To"),
    date:
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : rawDate || null,
    snippet: message.snippet ?? "",
    hasAttachments: parts.some((part) => !!part.filename),
  };
}

function detail(message: GmailApiMessage): GmailMessageDetail {
  const parts = allParts(message.payload);
  const plain = parts.find(
    (part) => part.mimeType === "text/plain" && part.body?.data,
  );
  const html = parts.find(
    (part) => part.mimeType === "text/html" && part.body?.data,
  );
  const rootData = message.payload?.body?.data;
  let body = plain?.body?.data
    ? decodeBase64Url(plain.body.data)
    : html?.body?.data
      ? stripHtml(decodeBase64Url(html.body.data))
      : rootData
        ? decodeBase64Url(rootData)
        : (message.snippet ?? "");
  body = body
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 2_000_000);
  return {
    ...summarize(message),
    cc: header(message, "Cc"),
    body,
    attachments: parts
      .filter((part) => !!part.filename)
      .map((part) => ({
        filename: part.filename!,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
      })),
  };
}

async function getApiMessage(
  userId: string,
  messageId: string,
  db: Db,
): Promise<GmailApiMessage> {
  if (!/^[A-Za-z0-9_-]+$/.test(messageId)) {
    throw new GmailError("Invalid Gmail message ID.", 400);
  }
  const token = await accessToken(userId, db);
  return googleJson<GmailApiMessage>(
    `${GMAIL_API_URL}/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
    "Gmail message lookup",
  );
}

export async function searchGmailMessages(params: {
  userId: string;
  query?: string;
  maxResults?: number;
  db?: Db;
}): Promise<{ messages: GmailMessageSummary[]; resultSizeEstimate: number }> {
  const db = params.db ?? createServerDatabase();
  const token = await accessToken(params.userId, db);
  const maxResults = Math.min(
    50,
    Math.max(1, Math.floor(params.maxResults ?? 25)),
  );
  const url = new URL(`${GMAIL_API_URL}/users/me/messages`);
  url.searchParams.set("maxResults", String(maxResults));
  if (params.query?.trim())
    url.searchParams.set("q", params.query.trim().slice(0, 1000));
  const listed = await googleJson<{
    messages?: Array<{ id?: string }>;
    resultSizeEstimate?: number;
  }>(
    url.toString(),
    { headers: { Authorization: `Bearer ${token}` } },
    "Gmail search",
  );
  const ids = (listed.messages ?? [])
    .map((item) => item.id)
    .filter((id): id is string => !!id);
  const messages: GmailMessageSummary[] = [];
  for (let index = 0; index < ids.length; index += 5) {
    const batch = ids.slice(index, index + 5);
    const rows = await Promise.all(
      batch.map((id) =>
        googleJson<GmailApiMessage>(
          `${GMAIL_API_URL}/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } },
          "Gmail message lookup",
        ),
      ),
    );
    messages.push(...rows.map(summarize).filter((item) => !!item.id));
  }
  return {
    messages,
    resultSizeEstimate: listed.resultSizeEstimate ?? messages.length,
  };
}

export async function getGmailMessage(
  userId: string,
  messageId: string,
  db: Db = createServerDatabase(),
): Promise<GmailMessageDetail> {
  return detail(await getApiMessage(userId, messageId, db));
}

function safeFilename(subject: string, messageId: string): string {
  const base =
    subject
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || `Gmail message ${messageId}`;
  return `${base}.docx`;
}

async function messageDocx(message: GmailMessageDetail): Promise<Buffer> {
  const metadata = [
    ["From", message.from],
    ["To", message.to],
    ["Cc", message.cc],
    ["Date", message.date ?? ""],
    ["Gmail message ID", message.id],
  ].filter(([, value]) => !!value);
  const paragraphs = message.body
    .split(/\r?\n/)
    .slice(0, 20_000)
    .map((line) => new Paragraph({ children: [new TextRun(line || " ")] }));
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: message.subject, heading: HeadingLevel.TITLE }),
          ...metadata.map(
            ([label, value]) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `${label}: `, bold: true }),
                  new TextRun(value),
                ],
              }),
          ),
          new Paragraph({ text: "Message", heading: HeadingLevel.HEADING_1 }),
          ...paragraphs,
          ...(message.attachments.length
            ? [
                new Paragraph({
                  text: "Attachments",
                  heading: HeadingLevel.HEADING_1,
                }),
                ...message.attachments.map(
                  (attachment) =>
                    new Paragraph({
                      text: attachment.filename,
                      bullet: { level: 0 },
                    }),
                ),
              ]
            : []),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}

export async function importGmailMessage(params: {
  userId: string;
  messageId: string;
  projectId?: string | null;
  db?: Db;
}) {
  const db = params.db ?? createServerDatabase();
  const message = await getGmailMessage(params.userId, params.messageId, db);
  return createDocumentFromBytes({
    userId: params.userId,
    projectId: params.projectId ?? null,
    filename: safeFilename(message.subject, message.id),
    content: await messageDocx(message),
    source: "gmail",
    db,
  });
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export async function sendGmailMessage(params: {
  userId: string;
  to: string;
  subject: string;
  text: string;
  db?: Db;
}): Promise<void> {
  const db = params.db ?? createServerDatabase();
  const token = await accessToken(params.userId, db);
  const subject = `=?UTF-8?B?${Buffer.from(cleanHeader(params.subject), "utf8").toString("base64")}?=`;
  const raw = [
    `To: ${cleanHeader(params.to)}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(params.text, "utf8").toString("base64"),
  ].join("\r\n");
  await googleJson(
    `${GMAIL_API_URL}/users/me/messages/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    },
    "Gmail send",
  );
}
