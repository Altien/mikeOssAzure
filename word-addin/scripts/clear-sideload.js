/**
 * Best-effort `office-addin-debugging stop` before an automatically sideloaded
 * `npm start` (wired as its "prestart" hook).
 *
 * Why: office-addin-debugging registers the add-in by hard-linking
 * manifest.xml into Word's sideload folder. If a previous run exited
 * without `npm run stop` (crash, Ctrl-C, killed terminal), the link is
 * left behind and the next launch dies with an opaque
 * "EEXIST: file already exists, link 'manifest.xml' -> …/wef/….manifest.xml".
 * Stopping first makes both launch commands idempotent.
 *
 * Failures are swallowed on purpose: on a clean machine there is nothing
 * to stop, and a broken stop must never block start (start will surface
 * its own, more actionable, error).
 */
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

const addinDir = path.resolve(__dirname, "..");
const envPath = path.join(addinDir, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envPath);
}

const disabledValues = new Set(["0", "false", "no", "off"]);
if (
  disabledValues.has(
    String(process.env.WORD_ADDIN_SIDELOAD ?? "1").trim().toLowerCase()
  )
) {
  process.exit(0);
}

spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "office-addin-debugging", "stop", "manifest.xml"],
  { stdio: "ignore", cwd: addinDir }
);
process.exit(0);
