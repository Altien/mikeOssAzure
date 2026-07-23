// Application Insights initialisation. Imported as the very FIRST line
// of index.ts so its auto-instrumentation patches (HTTP, Express, pg,
// etc.) hook every subsequent require()/import in the process.
//
// Reads APPLICATIONINSIGHTS_CONNECTION_STRING from process.env, which
// the Container App receives via secretRef from KV's
// `appinsights-connection-string` secret (seeded by observability.bicep).
// When unset — local dev, OSS deploys without App Insights — the SDK
// silently no-ops, no telemetry is emitted, no errors thrown.
// The SDK is optional and remains disabled when no connection string is set.

import * as appInsights from "applicationinsights";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
    appInsights
        .setup(connectionString)
        // Enable the common auto-collected signals. Defaults are sensible
        // but called out explicitly so future maintainers see what's on.
        .setAutoCollectRequests(true) // express / http server requests
        .setAutoCollectPerformance(true, true) // node process counters (+extended)
        .setAutoCollectExceptions(true) // uncaught
        .setAutoCollectDependencies(true) // outbound http / postgres
        .setAutoCollectConsole(true, true) // console.* with severity
        .setUseDiskRetryCaching(true) // queue locally if AI is unreachable
        .setSendLiveMetrics(false) // not needed for batch backend
        .setInternalLogging(false, false)
        .start();

    // Tag every telemetry item with a stable role name so the App
    // Insights UI groups our events distinctly from anything else
    // sharing the workspace.
    appInsights.defaultClient.context.tags[
        appInsights.defaultClient.context.keys.cloudRole
    ] = "mike-backend";

    // eslint-disable-next-line no-console
    console.log("[telemetry] Application Insights initialised");
} else {
    // eslint-disable-next-line no-console
    console.log(
        "[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set — telemetry disabled",
    );
}

export {};
