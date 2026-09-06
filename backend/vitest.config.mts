import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests must never touch the developer's real databases under
// <cwd>/data/. CI gets this isolation for free (a fresh checkout has no
// data/ directory), so local runs get their own empty, disposable copies.
// One directory per run, so concurrent or repeated runs cannot see each
// other's residue. Leftovers under os.tmpdir() are OS-managed.
const sqliteTestDir = mkdtempSync(path.join(os.tmpdir(), "mike-vitest-"));

export default defineConfig({
    test: {
        environment: "node",
        // Unit/integration tests use the self-contained local profile unless a
        // provider-specific test overrides it explicitly.
        env: {
            MIKE_DATABASE_PROVIDER: "sqlite",
            MIKE_STORAGE_PROVIDER: "sqlite",
            MIKE_AUTH_PROVIDER: "local",
            SQLITE_DB_PATH: path.join(sqliteTestDir, "mike.sqlite"),
            SQLITE_STORAGE_PATH: path.join(sqliteTestDir, "mike-files.sqlite"),
        },
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        fileParallelism: false,
        // Generous timeouts so cold-start module transform/import latency
        // can't cause spurious timeout failures on a cold CI runner. Warm
        // tests finish in ~1s; this only guards the pathological cold case —
        // it does not mask hangs.
        testTimeout: 20000,
        hookTimeout: 20000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/lib/**"],
            // No-regression RATCHET floor, not a target. src/lib/** spans the
            // tested libs (access, storage keys/dispositions, downloadTokens,
            // userApiKeys provider/env checks, chat doc resolution,
            // llm model resolution, chat citations, userLookup,
            // documentVersions, userDataCleanup, docxTrackedChanges,
            // documentTypes, chat prompts, workflow catalog ingestion) AND the large,
            // lightly tested feature libs (courtlistener, mcp, chat tool
            // dispatch, llm providers, spreadsheet handling). Measured on
            // this tree: 52.72% statements, 46.31% branches, 53.24% functions,
            // 54.11% lines. These floors sit just below that (rounded down to
            // whole percents) so CI
            // fails on a *drop*. Floors only go up: when you add tests, raise
            // them in the same PR. Backlog + per-area status:
            // docs/testing-coverage.md.
            thresholds: {
                statements: 52,
                branches: 46,
                functions: 53,
                lines: 54,
            },
        },
    },
});
