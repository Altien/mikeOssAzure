// Order matters here.
//   1. dotenv/config: loads .env into process.env so the next line can
//      read APPLICATIONINSIGHTS_CONNECTION_STRING from a local .env in
//      dev. (In Azure the env var comes from Container App secretRef,
//      no .env file involved.)
//   2. telemetry: applicationinsights' auto-instrumentation patches
//      require()/import at module-load time, so anything network-y
//      (http, express, pg, ...) MUST be imported AFTER this for those
//      calls to be captured. dotenv is a one-shot file reader with no
//      network/DB side effects, so it's safe before telemetry.
//   3. app construction lives in ./app (buildApp) so tests can mount the
//      Express app via supertest without binding a port or pulling in
//      telemetry/process-guard side effects.
import "dotenv/config";
import "./telemetry";
import { installProcessGuards } from "./lib/processGuards";
installProcessGuards();
import { buildApp } from "./app";
import { initDownloadSigningSecret } from "./lib/downloadTokens";

const PORT = process.env.PORT ?? 3001;

// Warm the download-token signing secret from Key Vault before accepting
// traffic — Azure deploys don't secretRef it into the env (040 Entry 19),
// and the sync signing path needs it in process.env. resolveSecret never
// rejects; .finally() is belt-and-braces so a bug there can't stop listen.
initDownloadSigningSecret().finally(() => {
  buildApp().listen(PORT, () => {
    console.log(`Mike backend running on port ${PORT}`);
  });
});
