import { app } from "./app";
import { startLegalMonitorScheduler } from "./lib/legalMonitorScheduler";
import { resolveDeploymentModules } from "./lib/deploymentModules";
import { manifestPublicKey } from "./lib/manifestSigning";
import { validateRuntimeConfiguration } from "./lib/runtimeConfig";

const PORT = process.env.PORT ?? 3001;

// Validate the deployment allow-list before opening a listener or starting
// background module work.
resolveDeploymentModules();

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
try {
  validateRuntimeConfiguration();
  const signingKey = manifestPublicKey();
  if (signingKey) {
    console.log(`Export manifests signed with key ${signingKey.key_id}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection", reason);
});

const server = app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});

const stopLegalMonitorScheduler = startLegalMonitorScheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopLegalMonitorScheduler();
    server.close(() => process.exit(0));
  });
}
