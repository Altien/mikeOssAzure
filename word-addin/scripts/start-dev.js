/**
 * Start Word add-in development with optional automatic sideloading.
 *
 * Set WORD_ADDIN_SIDELOAD=0 (also accepts false, no, or off) to run only the
 * webpack development server. This keeps `npm start`, `npm run dev`, and
 * `bun dev` useful without opening a fresh Word document on every restart.
 */
const { existsSync } = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const addinDir = path.resolve(__dirname, "..");
const envPath = path.join(addinDir, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envPath);
}

const disabledValues = new Set(["0", "false", "no", "off"]);
const shouldSideload = !disabledValues.has(
  String(process.env.WORD_ADDIN_SIDELOAD ?? "1").trim().toLowerCase()
);
const executable = shouldSideload
  ? process.platform === "win32"
    ? "npx.cmd"
    : "npx"
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const args = shouldSideload
  ? [
      "--no-install",
      "office-addin-debugging",
      "start",
      "manifest.xml",
      "--dev-server",
      "npm run dev:server",
      "--dev-server-port",
      "3200",
    ]
  : ["run", "dev:server"];

if (!shouldSideload) {
  console.log(
    "WORD_ADDIN_SIDELOAD=0 — starting the dev server without opening Word."
  );
}

const child = spawn(executable, args, {
  cwd: addinDir,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
