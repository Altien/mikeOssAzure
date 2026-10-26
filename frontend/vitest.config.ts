import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

// Local worker cap. Vitest's default for `vitest run` is one fork per CPU
// core minus one, so on a 10-12 core laptop a single `pnpm test` starts 9-11
// forks, and running the frontend and backend suites together doubles that.
// The frontend forks each boot jsdom. That was enough to crash a teammate's
// laptop. Locally we use at most half the cores and at most one worker per
// 4 GiB of RAM (8 GiB -> 2, 16 GiB -> 4). CI runners are dedicated machines,
// so they keep Vitest's default. To change the cap for one run, pass
// `--maxWorkers=<n>` or set VITEST_MAX_WORKERS.
const localMaxWorkers = Math.max(
    Math.min(
        Math.floor(availableParallelism() / 2),
        Math.floor(totalmem() / (4 * 1024 ** 3)),
    ),
    1,
);

export default defineConfig({
    plugins: [tsconfigPaths(), react()],
    // Match Next file-backed imported images for preload checks.
    build: { assetsInlineLimit: 0 },
    resolve: {
        // Upstream #450 test (src/wordAddin/client.test.ts) imports Word add-in
        // source outside this root, and the shared packages' colocated tests
        // live in ../packages; tsconfigPaths() does not apply the frontend
        // paths there, so mirror upstream's explicit package aliases
        // (upstream vitest.config.mts, a1c87117).
        alias: [
            { find: /^@mike\/ui$/, replacement: fileURLToPath(new URL("../packages/ui/src/index.ts", import.meta.url)) },
            { find: /^@mike\/client$/, replacement: fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url)) },
            { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
            // JSX compilation adds these imports even when source imports only
            // React. Resolve both runtimes beside the same frontend React copy.
            { find: /^react\/(jsx-runtime|jsx-dev-runtime)$/, replacement: fileURLToPath(new URL("./node_modules/react/$1.js", import.meta.url)) },
            { find: /^@sentry\/react$/, replacement: fileURLToPath(new URL("./node_modules/@sentry/react/build/esm/index.js", import.meta.url)) },
            { find: /^@sentry\/nextjs$/, replacement: fileURLToPath(new URL("./node_modules/@sentry/react/build/esm/index.js", import.meta.url)) },
        ],
        // packages/ui and packages/client have no node_modules of their own.
        // Vite resolves a bare import from the importer's directory, which
        // for a file under packages/ never reaches frontend/node_modules;
        // dedupe makes these resolve from this package instead. Mirror
        // packages/*/package.json peerDependencies plus the test tooling the
        // packages' colocated tests import.
        dedupe: [
            "react",
            "react-dom",
            "clsx",
            "tailwind-merge",
            "lucide-react",
            "@radix-ui/react-dropdown-menu",
            "vitest",
            "@testing-library/react",
            "@testing-library/user-event",
            "postcss",
        ],
    },
    server: {
        // The shared packages' tests and sources sit outside this directory.
        fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    },
    test: {
        environment: "jsdom",
        maxWorkers: process.env.CI ? undefined : localMaxWorkers,
        globals: false,
        include: [
            "src/**/*.{test,spec}.{ts,tsx}",
            // The shared packages' colocated tests run here: they need the
            // same jsdom + Testing Library setup (upstream a1c87117).
            "../packages/ui/src/**/*.test.{ts,tsx}",
            "../packages/client/src/**/*.test.{ts,tsx}",
        ],
        setupFiles: ["src/test/setup.ts"],
        css: false,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.{ts,tsx}"],
            exclude: [
                "src/**/*.test.{ts,tsx}",
                "src/**/*.spec.{ts,tsx}",
                "src/test/**",
                "src/app/**/page.tsx",
                "src/app/**/layout.tsx",
                "src/app/**/loading.tsx",
                "src/app/**/error.tsx",
                "src/app/**/not-found.tsx",
                "src/app/**/global-error.tsx",
                "src/**/*.d.ts",
            ],
        },
        clearMocks: true,
        restoreMocks: true,
    },
});
