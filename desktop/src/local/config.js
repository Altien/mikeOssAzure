// Shared constants for the self-contained local stack.
//
// Fixed ports keep local service wiring stable across launches. The supervisor
// supplies these URLs at runtime; the frontend uses its same-origin /api
// gateway and carries no Supabase keys. Port conflicts fail startup.

const path = require("path");

const PORTS = {
  postgres: 42810,
  postgrest: 42812,
  gateway: 42813, // backend-only Supabase auth/data gateway
  backend: 42814,
  frontend: 42815, // reserved legacy port; Dev serves the UI on backend
};

// Dev serves its static export and /config from the backend origin.
const FRONTEND_URL = `http://127.0.0.1:${PORTS.backend}`;
const GATEWAY_URL = `http://localhost:${PORTS.gateway}`;
const BACKEND_URL = FRONTEND_URL;

// Where the binaries and built app live. Dev mode runs straight out of the
// repo checkout; the packaged app carries the same layout in resources.
function stackPaths(app) {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "local-stack")
    : path.join(repoRoot, "desktop", "local-stack");
  return {
    bin: path.join(base, "bin"),
    pgBin: path.join(base, "bin", "pg", "bin"),
    postgrest: path.join(base, "bin", "postgrest"),
    backendDir: app.isPackaged
      ? path.join(base, "app", "backend")
      : path.join(repoRoot, "backend"),
    frontendPublic: app.isPackaged
      ? path.join(base, "app", "backend", "public")
      : path.join(repoRoot, "frontend", "out"),
  };
}

// Per-install mutable state, quarantined under userData/local so wiping it
// resets the local product without touching shell settings.
function dataPaths(app) {
  const root = path.join(app.getPath("userData"), "local");
  return {
    root,
    pgdata: path.join(root, "pgdata"),
    storage: path.join(root, "storage"),
    logs: path.join(root, "logs"),
    secretsFile: path.join(root, "secrets.json"),
    operatorConfig: path.join(root, "operator-config.json"),
  };
}

module.exports = {
  PORTS,
  FRONTEND_URL,
  GATEWAY_URL,
  BACKEND_URL,
  stackPaths,
  dataPaths,
};
