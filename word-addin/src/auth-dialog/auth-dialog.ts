/// <reference types="office-js" />
/**
 * Office-dialog fallback for Microsoft sign-in (hosts without Nested App
 * Authentication). Opened by the task pane via displayDialogAsync (see
 * taskpane/auth/entra.ts). First load: start MSAL's redirect sign-in. After
 * Entra redirects back here (this page is the registered SPA redirect URI
 * `https://<add-in host>/auth-dialog.html`): hand the access token to the
 * pane with messageParent and let the pane close the dialog.
 */
import { loadRuntimeConfig } from "../taskpane/auth/runtimeConfig";
import {
  createDialogFlowClient,
  entraConfigProblem,
  type AuthDialogMessage,
} from "../taskpane/auth/entra";

function reply(message: AuthDialogMessage): void {
  Office.context.ui.messageParent(JSON.stringify(message));
}

async function run(): Promise<void> {
  const cfg = await loadRuntimeConfig();
  const problem = entraConfigProblem(cfg);
  if (cfg.authProvider !== "entra" || problem) {
    throw new Error(problem ?? "Microsoft sign-in is not enabled on this Mike server.");
  }
  const pca = await createDialogFlowClient(cfg);
  const result = await pca.handleRedirectPromise();
  if (result) {
    reply({
      type: "success",
      accessToken: result.accessToken,
      expiresOn: result.expiresOn ? result.expiresOn.getTime() : null,
      homeAccountId: result.account?.homeAccountId ?? null,
    });
    return;
  }
  await pca.acquireTokenRedirect({
    scopes: [cfg.entra.apiScope],
    prompt: "select_account",
  });
}

Office.onReady(() => {
  run().catch((e: unknown) => {
    reply({
      type: "error",
      message: e instanceof Error ? e.message : "Sign-in failed",
    });
  });
});
