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

function send(message: GoogleOAuthDialogMessage): boolean {
  // No legacy (option-less) retry on failure: dropping targetOrigin would
  // weaken the receiver's origin check (session.ts skips it when the host
  // omits event.origin), and every host this add-in supports has the
  // DialogOrigin 1.1 set. A visible failure beats a weaker handoff.
  try {
    Office.context.ui.messageParent(JSON.stringify(message), {
      targetOrigin: window.location.origin,
    });
    return true;
  } catch {
    setStatus(
      "Could not hand the session back to Word. Close this window and try signing in again."
    );
    return false;
  }
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
  // localStorage is included only to sweep up sessions persisted there by
  // earlier builds of this dialog; the client now writes sessionStorage.
  for (const storage of [window.sessionStorage, window.localStorage]) {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(`${STORAGE_KEY}-code-verifier`);
  }
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

  // This client exists only to run the PKCE round trip. Its persistence has
  // to survive exactly one same-tab redirect (to Google and back), so it
  // lives in sessionStorage — never localStorage, where a crash between the
  // code exchange and cleanup would leave a full session readable on disk.
  // The task pane's real session storage is OfficeRuntime.storage; browser
  // storage must never hold long-lived credentials (see office-mock.ts).
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: true,
      storage: window.sessionStorage,
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
    // Deliberately NO supabase.auth.signOut() here: even scope "local"
    // POSTs /logout with the session JWT, and GoTrue revokes that session's
    // refresh token server-side — the very token being handed to the task
    // pane below. Removing the persisted storage keys (next line) plus
    // autoRefreshToken:false is the complete local cleanup.
    clearTemporaryAuthStorage();
    if (send(message)) {
      setStatus("Signed in. You can return to Word.");
    }
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
