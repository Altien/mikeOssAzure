/// <reference types="office-js" />
import { createClient } from "@supabase/supabase-js";
import {
  GOOGLE_OAUTH_MESSAGE_TYPE,
  type GoogleOAuthDialogMessage,
} from "../taskpane/auth/oauthProtocol";

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY ?? "";
const STORAGE_KEY = "mike-word-google-oauth";
const REQUEST_STORAGE_KEY = "mike-word-google-oauth-request";

function setStatus(message: string): void {
  const element = document.getElementById("status");
  if (element) element.textContent = message;
}

function send(message: GoogleOAuthDialogMessage): void {
  Office.context.ui.messageParent(JSON.stringify(message), {
    targetOrigin: window.location.origin,
  });
}

function sendError(requestId: string, message: string): void {
  setStatus(message);
  send({
    type: GOOGLE_OAUTH_MESSAGE_TYPE,
    requestId,
    status: "error",
    message,
  });
}

function clearTemporaryAuthStorage(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(`${STORAGE_KEY}-code-verifier`);
  window.sessionStorage.removeItem(REQUEST_STORAGE_KEY);
}

async function runGoogleOAuth(): Promise<void> {
  const currentUrl = new URL(window.location.href);
  const requestedId = currentUrl.searchParams.get("requestId");
  if (requestedId) {
    window.sessionStorage.setItem(REQUEST_STORAGE_KEY, requestedId);
  }
  const requestId =
    requestedId ?? window.sessionStorage.getItem(REQUEST_STORAGE_KEY) ?? "";
  if (!requestId) {
    setStatus("This sign-in request is invalid. Close this window and try again.");
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    sendError(requestId, "Google sign-in is not configured for this add-in.");
    return;
  }

  const providerError =
    currentUrl.searchParams.get("error_description") ??
    currentUrl.searchParams.get("error");
  if (providerError) {
    clearTemporaryAuthStorage();
    sendError(requestId, providerError);
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: true,
      storage: window.localStorage,
      storageKey: STORAGE_KEY,
    },
  });

  const code = currentUrl.searchParams.get("code");
  if (code) {
    setStatus("Completing sign-in…");
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session?.access_token || !data.session.refresh_token) {
      clearTemporaryAuthStorage();
      sendError(
        requestId,
        error?.message ?? "Google did not return a complete Supabase session."
      );
      return;
    }

    const message: GoogleOAuthDialogMessage = {
      type: GOOGLE_OAUTH_MESSAGE_TYPE,
      requestId,
      status: "success",
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    };
    clearTemporaryAuthStorage();
    setStatus("Signed in. You can return to Word.");
    send(message);
    return;
  }

  const redirectUrl = new URL("/oauth-dialog.html", window.location.origin);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl.toString(),
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    clearTemporaryAuthStorage();
    sendError(requestId, error?.message ?? "Unable to open Google sign-in.");
    return;
  }

  window.location.assign(data.url);
}

Office.onReady(() => {
  void runGoogleOAuth().catch((error: unknown) => {
    const requestId =
      new URL(window.location.href).searchParams.get("requestId") ??
      window.sessionStorage.getItem(REQUEST_STORAGE_KEY);
    const message =
      error instanceof Error ? error.message : "Unable to complete Google sign-in.";
    if (requestId) {
      sendError(requestId, message);
    } else {
      setStatus(message);
    }
  });
});
