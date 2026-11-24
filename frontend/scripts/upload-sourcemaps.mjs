// Uploads the static export's browser source maps to Sentry, then deletes
// them from frontend/out so no map ships in the image. Run after `next build`
// with SENTRY_UPLOAD_ENABLED=1 (next.config.ts then emits the maps).
//
// Upstream (3bcac35a) uploads from @sentry/nextjs's `withSentryConfig`, which
// Dev's static export does not use. This drives the same Sentry build-plugin
// manager that `withSentryConfig` uses for Turbopack builds: inject debug IDs
// into the emitted JS, upload the maps under the release the browser reports
// (mike@<version>+<sha12>, frontend/src/shared/lib/releaseName.cjs), delete
// the maps afterwards.
//
// Required: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT. The image build
// gets the token from deploy.ps1 / scripts/release-images.sh, which read it
// from Key Vault first and fall back to the SENTRY_AUTH_TOKEN env var.
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createSentryBuildPluginManager } from "@sentry/bundler-plugins/core";

const require = createRequire(import.meta.url);
const { releaseName } = require("../src/shared/lib/releaseName.cjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..", "out");

const missing = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].filter(
  (name) => !process.env[name]?.trim(),
);
if (missing.length > 0) {
  console.error(`[sourcemaps] missing ${missing.join(", ")}; nothing uploaded`);
  process.exit(1);
}
if (!existsSync(out)) {
  console.error("[sourcemaps] frontend/out not found — run `next build` first.");
  process.exit(1);
}

// The release the backend serves in /config (same image, same build args).
const release = releaseName(process.env.SENTRY_RELEASE, process.env.MIKE_VERSION, process.env.GIT_SHA);
const outGlob = out.replace(/\\/g, "/");

const manager = createSentryBuildPluginManager(
  {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    telemetry: false,
    release: { name: release },
    sourcemaps: { filesToDeleteAfterUpload: [`${outGlob}/**/*.map`] },
    // A failed upload fails the image build rather than shipping silently.
    errorHandler: (err) => {
      throw err;
    },
  },
  { buildTool: "nextjs-static-export", loggerPrefix: "[sourcemaps]" },
);

await manager.createRelease();
await manager.injectDebugIds([out]);
await manager.uploadSourcemaps([out], { prepareArtifacts: false });
await manager.deleteArtifacts();
console.log(`[sourcemaps] uploaded web app maps for ${release}`);
