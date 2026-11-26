// Business logic + data-access for the support module.
//
// A user reports a problem with one assistant response and may allow support
// staff to inspect that conversation (up to the response) and its project's
// documents for 14 days. This facade only records and withdraws reports. The
// database (migration 0200) derives the project and expiry, re-checks that the
// message is a completed response in the chat, and is the only place the
// operator reads reports, through its control-plane functions.

import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { getAccessibleChat } from "../chat/chat.service";

// Mirrors the support_reports check constraints.
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_CONSENT_TEXT_LENGTH = 2000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const REPORT_COLUMNS =
  "id, chat_id, project_id, message_id, allow_conversation, allow_documents, created_at, access_expires_at, withdrawn_at";

export type SupportReport = {
  id: string;
  chat_id: string;
  project_id: string | null;
  message_id: string;
  allow_conversation: boolean;
  allow_documents: boolean;
  created_at: string;
  access_expires_at: string | null;
  withdrawn_at: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export async function createSupportReport(
  db: Db,
  args: { userId: string; userEmail: string | null | undefined; body: unknown },
): Promise<ServiceResult<SupportReport>> {
  const body = asRecord(args.body);
  const { chat_id: chatId, message_id: messageId } = body;
  if (!isUuid(chatId) || !isUuid(messageId)) {
    return failure("validation", "chat_id and message_id are required");
  }
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    return failure(
      "validation",
      `Describe the issue in 1 to ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  const allowConversation = body.allow_conversation === true;
  const allowDocuments = body.allow_documents === true;
  const consentText =
    typeof body.consent_text === "string" ? body.consent_text : null;
  if (consentText !== null && consentText.length > MAX_CONSENT_TEXT_LENGTH) {
    return failure("validation", "consent_text is too long");
  }
  if ((allowConversation || allowDocuments) && !consentText?.trim()) {
    return failure("validation", "consent_text is required when access is allowed");
  }

  const access = await getAccessibleChat(db, {
    chatId,
    userId: args.userId,
    userEmail: args.userEmail,
  });
  if (!access.ok) return failure("not_found", "Chat not found");

  const { data: message, error: messageError } = await db
    .from("chat_messages")
    .select("id")
    .eq("id", messageId)
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .not("content", "is", null)
    .maybeSingle();
  if (messageError) return internalFailure(messageError);
  if (!message) return failure("not_found", "Message not found");

  const { data, error } = await db
    .from("support_reports")
    .insert({
      user_id: args.userId,
      chat_id: chatId,
      message_id: messageId,
      description,
      allow_conversation: allowConversation,
      allow_documents: allowDocuments,
      consent_text: consentText,
    })
    .select(REPORT_COLUMNS)
    .single();
  if (error || !data) return internalFailure(error);
  return ok(data as SupportReport);
}

/** Withdraw the caller's own report. Repeating it keeps the first time. */
export async function withdrawSupportReport(
  db: Db,
  args: { userId: string; reportId: string },
): Promise<ServiceResult<SupportReport>> {
  const { data, error } = await db
    .from("support_reports")
    .update({ withdrawn_at: new Date().toISOString() })
    .eq("id", args.reportId)
    .eq("user_id", args.userId)
    .select(REPORT_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Report not found");
  return ok(data as SupportReport);
}
