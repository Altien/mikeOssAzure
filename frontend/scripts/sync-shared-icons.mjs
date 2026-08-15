#!/usr/bin/env node
/**
 * Mirrors shared/icons/ into frontend/public/icons/.
 *
 * Next.js only serves static assets that physically exist under public/, so the
 * web app cannot import the shared icon set the way the Word add-in does (which
 * aliases @icons straight at shared/icons and lets webpack emit the files).
 * This copy is the frontend's delivery mechanism for that same source of truth;
 * public/icons is generated output and is git-ignored.
 *
 * Runs from predev/prebuild/predeploy/prepreview/preupload, so every npm entry
 * point regenerates it. Pass --check to verify without writing (exit 1 if the
 * mirror is missing, stale, or has extra files).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "..", "shared", "icons");
const TARGET = join(here, "..", "public", "icons");

const checkOnly = process.argv.includes("--check");

/** Relative paths of every .svg under `dir`, or [] when it does not exist. */
async function listSvgs(dir) {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".svg"))
        .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)));
}

const [sourceIcons, targetIcons] = await Promise.all([
    listSvgs(SOURCE),
    listSvgs(TARGET),
]);

if (sourceIcons.length === 0) {
    console.error(`sync-shared-icons: no SVGs found in ${SOURCE}`);
    process.exit(1);
}

const stale = [];
const extra = targetIcons.filter((icon) => !sourceIcons.includes(icon));

for (const icon of sourceIcons) {
    const from = join(SOURCE, icon);
    const to = join(TARGET, icon);
    const contents = await readFile(from);

    if (existsSync(to) && (await readFile(to)).equals(contents)) continue;

    stale.push(icon);
    if (checkOnly) continue;

    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, contents);
}

// Drop icons deleted or renamed upstream so public/ can't serve a ghost.
for (const icon of extra) {
    if (!checkOnly) await rm(join(TARGET, icon));
}

// Pruning can empty a directory (e.g. the old app-sidebar/ and file-types/
// nesting); leave no empty shells behind.
if (!checkOnly && extra.length > 0) {
    for (const entry of await readdir(TARGET, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(TARGET, entry.name);
        if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true });
    }
}

if (checkOnly) {
    if (stale.length === 0 && extra.length === 0) {
        console.log(`sync-shared-icons: public/icons matches shared/icons (${sourceIcons.length} icons)`);
        process.exit(0);
    }
    for (const icon of stale) console.error(`  stale or missing: ${icon}`);
    for (const icon of extra) console.error(`  not in shared/icons: ${icon}`);
    console.error("sync-shared-icons: run `node frontend/scripts/sync-shared-icons.mjs`");
    process.exit(1);
}

console.log(
    `sync-shared-icons: ${sourceIcons.length} icons -> public/icons` +
        ` (${stale.length} written, ${extra.length} removed)`,
);
