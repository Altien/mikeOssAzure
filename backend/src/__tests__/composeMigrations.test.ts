import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The compose stack has no migration runner: `db-init` loads schema.sql on a
// fresh volume and then REPLAYS a hard-coded list of migrations, because an
// existing volume skips schema.sql entirely and would otherwise never see a
// new table. Adding a migration without adding it here is silent — the stack
// boots fine and only the feature that needs the new object breaks, at
// runtime, in whatever container happens to touch it first.
//
// The list starts at 20260823_01 (everything older predates the replay block
// and is baked into schema.sql for every volume that exists today), so the
// invariant this test enforces is: every migration from that file onward must
// be BOTH mounted and psql'd by db-init.
const REPLAY_FROM = "20260823_01";

const repoRoot = path.resolve(__dirname, "../../..");

describe("docker-compose db-init migration replay", () => {
    const compose = readFileSync(
        path.join(repoRoot, "docker-compose.yml"),
        "utf8",
    );
    const migrations = readdirSync(path.join(repoRoot, "backend/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .filter((f) => f >= REPLAY_FROM)
        .sort();

    it("has migrations to check", () => {
        expect(migrations.length).toBeGreaterThan(0);
    });

    it.each(migrations)("mounts and applies %s", (file) => {
        // Plain string search, no dynamically built RegExp: the filename
        // comes from readdirSync so nothing hostile reaches it, but a regex
        // assembled from it still needs every metacharacter escaped
        // (CodeQL js/incomplete-sanitization), and an exact-substring probe
        // needs none.
        const needle = `./backend/migrations/${file}:`;
        const mountLine = compose
            .split("\n")
            .find((line) => line.includes(needle));
        expect(
            mountLine,
            `docker-compose.yml does not mount backend/migrations/${file} into db-init`,
        ).toBeDefined();
        const containerPath = mountLine!
            .slice(mountLine!.indexOf(needle) + needle.length)
            .split(":")[0]
            .trim();
        expect(
            compose.includes(`-f ${containerPath};`),
            `docker-compose.yml mounts ${file} at ${containerPath} but never psql's it`,
        ).toBe(true);
    });
});
