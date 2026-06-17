// One-shot local setup: docker stack → migrate → azurite container → bundle
// frontend into the backend. After this, run `cd backend && pnpm dev` and open
// http://localhost:3001. Cross-platform. Idempotent (safe to re-run).
//
//   node scripts/local-setup.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function run(cmd, args, cwd) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}   (${path.relative(root, cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`\n✗ failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function waitForPostgres() {
  process.stdout.write("\n⏳ waiting for postgres to be healthy");
  for (let i = 0; i < 60; i++) {
    const r = spawnSync(
      "docker",
      ["compose", "-f", "docker-compose.dev.yml", "exec", "-T", "postgres", "pg_isready", "-U", "mikeadmin"],
      { cwd: root, stdio: "ignore", shell: isWin },
    );
    if (r.status === 0) {
      console.log(" — ready");
      return;
    }
    process.stdout.write(".");
    spawnSync(isWin ? "timeout" : "sleep", isWin ? ["/t", "1"] : ["1"], { stdio: "ignore", shell: isWin });
  }
  console.error("\n✗ postgres did not become ready in time");
  process.exit(1);
}

run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"], root);
waitForPostgres();
run("pnpm", ["migrate:local"], path.join(root, "backend"));
run("pnpm", ["azurite:init"], path.join(root, "backend"));
run("pnpm", ["bundle"], path.join(root, "frontend"));

console.log(
  "\n✅ Local setup complete.\n" +
    "   Configure backend/.env (Entra app regs — see docs/runbook-entra-local-auth.md),\n" +
    "   then:  cd backend && pnpm dev   →   open http://localhost:3001",
);
