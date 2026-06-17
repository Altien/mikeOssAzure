// Copies the static export (frontend/out) into where the backend serves it
// (backend/public). Run after `next build`. Cross-platform — replaces the
// manual `Copy-Item` / `cp -r` step. Used by `pnpm bundle`.
import { rm, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // frontend/scripts
const out = path.resolve(here, "..", "out");
const dest = path.resolve(here, "..", "..", "backend", "public");

if (!existsSync(out)) {
  console.error("[bundle] frontend/out not found — run `next build` first.");
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(out, dest, { recursive: true });
console.log("[bundle] frontend/out → backend/public");
