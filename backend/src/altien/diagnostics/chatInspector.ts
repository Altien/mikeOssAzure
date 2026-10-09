import { Router } from "express";
import { checkProjectAccess } from "../../lib/access";
import { safeErrorMessage } from "../../lib/safeError";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";

const CHAT_TRACE_LIMIT_MAX = 100;
const CHAT_TRACE_TEXT_MAX = 20_000;
const SAFE_EVENT_FIELDS = new Set([
  "run_id", "outcome", "total", "anchored", "failed", "error", "query",
  "cluster_id", "cluster_ids", "case_name", "citation", "citation_count",
  "match_count", "case_count", "opinion_count", "total_matches",
  "result_count", "filename", "document_id", "tool_name", "server_name",
  "status", "duration_ms", "isStreaming",
]);

function boundedInteger(raw: unknown, fallback: number): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), CHAT_TRACE_LIMIT_MAX)
    : fallback;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= CHAT_TRACE_TEXT_MAX
    ? value
    : `${value.slice(0, CHAT_TRACE_TEXT_MAX)}…`;
}

function safeEventValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return boundedText(value);
  if (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((item) =>
      ["string", "number", "boolean"].includes(typeof item),
    )
  ) {
    return value;
  }
  return undefined;
}

function sanitizeAssistantEvent(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "case_opinions") return null;
  if (type === "content") return { type, text: boundedText(event.text) ?? "" };
  if (type === "reasoning") {
    return {
      type,
      characters: typeof event.text === "string" ? event.text.length : 0,
    };
  }
  const safe: Record<string, unknown> = { type };
  for (const field of SAFE_EVENT_FIELDS) {
    if (!(field in event)) continue;
    const value = safeEventValue(event[field]);
    if (value !== undefined) safe[field] = value;
  }
  return safe;
}

function sanitizeChatContent(content: unknown): unknown {
  if (typeof content === "string") return boundedText(content) ?? "";
  if (!Array.isArray(content)) return null;
  return content
    .map(sanitizeAssistantEvent)
    .filter((event): event is Record<string, unknown> => event !== null);
}

function sanitizeAnnotations(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set([
    "ref", "kind", "cluster_id", "case_name", "citation", "url",
    "document_id", "filename", "page", "sheet", "cell",
  ]);
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!allowed.has(key)) continue;
      const sanitized = safeEventValue(value);
      if (sanitized !== undefined) safe[key] = sanitized;
    }
    return [safe];
  });
}

function traceEvents(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.flatMap((message, messageIndex) => {
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((raw, eventIndex) => {
      const event = sanitizeAssistantEvent(raw);
      if (!event || event.type === "content" || event.type === "reasoning") {
        return [];
      }
      return [{
        message_id: String(message.id ?? ""),
        message_index: messageIndex,
        event_index: eventIndex,
        created_at: String(message.created_at ?? ""),
        ...event,
      }];
    });
  });
}

export const chatInspectorRouter = Router();

chatInspectorRouter.get("/chats", requireAuth, async (req, res) => {
  try {
    const userId = String(res.locals.userId ?? "");
    const limit = boundedInteger(req.query.limit, 20);
    const db = createServerSupabase();
    const { data, error } = await db
      .from("chats")
      .select("id, title, user_id, project_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(0, limit - 1);
    if (error) throw new Error(error.message);
    return res.json({ chats: data ?? [] });
  } catch (error) {
    return res.status(500).json({
      detail: safeErrorMessage(error, "Failed to load diagnostic chats"),
    });
  }
});

chatInspectorRouter.get("/chats/:chatId/trace", requireAuth, async (req, res) => {
  try {
    const userId = String(res.locals.userId ?? "");
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const { data: chat, error: chatError } = await db
      .from("chats")
      .select("id, title, user_id, project_id, created_at")
      .eq("id", req.params.chatId)
      .maybeSingle();
    if (chatError) throw new Error(chatError.message);
    if (!chat) return res.status(404).json({ detail: "Chat not found" });
    const row = chat as {
      id: string;
      title: string | null;
      user_id: string;
      project_id: string | null;
      created_at: string;
    };
    let authorized = row.user_id === userId;
    if (!authorized && row.project_id) {
      authorized = (
        await checkProjectAccess(row.project_id, userId, userEmail, db)
      ).ok;
    }
    if (!authorized) return res.status(404).json({ detail: "Chat not found" });

    const { data: messageData, error: messageError } = await db
      .from("chat_messages")
      .select("id, role, content, annotations, created_at")
      .eq("chat_id", row.id)
      .order("created_at", { ascending: true })
      .range(0, CHAT_TRACE_LIMIT_MAX - 1);
    if (messageError) throw new Error(messageError.message);
    const rawMessages = (messageData ?? []) as Array<Record<string, unknown>>;
    const timeline = traceEvents(rawMessages);
    const runIds = Array.from(new Set(
      timeline
        .filter((event) =>
          event.type === "authority_trace_verification" &&
          typeof event.run_id === "string",
        )
        .map((event) => event.run_id as string),
    ));
    let runs: unknown[] = [];
    if (runIds.length > 0) {
      const { data: runData, error: runError } = await db
        .from("citation_verification_runs")
        .select("id, project_id, report, created_at")
        .in("id", runIds);
      if (runError) throw new Error(runError.message);
      runs = ((runData ?? []) as Array<Record<string, unknown>>).filter(
        (run) => row.project_id && String(run.project_id ?? "") === row.project_id,
      );
    }
    return res.json({
      chat: row,
      messages: rawMessages.map((message) => ({
        id: String(message.id ?? ""),
        role: String(message.role ?? ""),
        content: sanitizeChatContent(message.content),
        annotations: sanitizeAnnotations(message.annotations),
        created_at: String(message.created_at ?? ""),
      })),
      timeline,
      authority_trace_runs: runs,
      truncated: rawMessages.length >= CHAT_TRACE_LIMIT_MAX,
    });
  } catch (error) {
    return res.status(500).json({
      detail: safeErrorMessage(error, "Failed to load diagnostic chat trace"),
    });
  }
});
