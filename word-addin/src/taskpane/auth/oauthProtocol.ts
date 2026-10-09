export const GOOGLE_OAUTH_MESSAGE_TYPE = "mike-google-oauth" as const;

export type GoogleOAuthDialogMessage =
  | {
      type: typeof GOOGLE_OAUTH_MESSAGE_TYPE;
      requestId: string;
      status: "success";
      handoffTicket: string;
    }
  | {
      type: typeof GOOGLE_OAUTH_MESSAGE_TYPE;
      requestId: string;
      status: "error";
      message: string;
    };

export function parseGoogleOAuthDialogMessage(
  value: string,
): GoogleOAuthDialogMessage | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.type !== GOOGLE_OAUTH_MESSAGE_TYPE ||
      typeof parsed.requestId !== "string"
    ) {
      return null;
    }

    if (
      parsed.status === "success" &&
      typeof parsed.handoffTicket === "string" &&
      /^[A-Za-z0-9_-]{32,256}$/.test(parsed.handoffTicket)
    ) {
      return {
        type: GOOGLE_OAUTH_MESSAGE_TYPE,
        requestId: parsed.requestId,
        status: "success",
        handoffTicket: parsed.handoffTicket,
      };
    }

    if (
      parsed.status === "error" &&
      typeof parsed.message === "string" &&
      parsed.message.length > 0
    ) {
      return {
        type: GOOGLE_OAUTH_MESSAGE_TYPE,
        requestId: parsed.requestId,
        status: "error",
        message: parsed.message,
      };
    }
  } catch {
    // The dialog boundary is untrusted input. Invalid messages are ignored.
  }

  return null;
}
