import { availableParallelism, totalmem } from "node:os";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Local worker cap. Vitest's default for `vitest run` is one fork per CPU
// core minus one, so on a 10-12 core laptop a single `pnpm test` starts 9-11
// forks, and running the frontend and backend suites together doubles that.
// That was enough to crash a teammate's laptop. Locally we use at most half
// the cores and at most one worker per 2 GiB of RAM (8 GiB -> 4, 16 GiB -> 8,
// so the core limit applies first). These forks run plain Node and peak around
// 130 MB each. The frontend config allows 4 GiB per worker because its forks
// boot jsdom. CI runners are dedicated machines, so they keep Vitest's
// default. To change the cap for one run, pass `--maxWorkers=<n>` or set
// VITEST_MAX_WORKERS.
const localMaxWorkers = Math.max(
  Math.min(
    Math.floor(availableParallelism() / 2),
    Math.floor(totalmem() / (2 * 1024 ** 3)),
  ),
  1,
);

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    maxWorkers: process.env.CI ? undefined : localMaxWorkers,
    globals: false,
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/test/**",
        "src/scripts/**",
        "src/index.ts",
      ],
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
