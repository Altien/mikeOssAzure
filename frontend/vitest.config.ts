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
        // source outside this root, where tsconfigPaths() does not apply the
        // frontend paths; mirror upstream's explicit alias for the shared client.
        alias: [
            { find: "@mike/model-catalog", replacement: fileURLToPath(new URL("./src/shared/lib/modelCatalog.ts", import.meta.url)) },
            { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
            { find: /^@sentry\/react$/, replacement: fileURLToPath(new URL("./node_modules/@sentry/react/build/esm/index.js", import.meta.url)) },
            { find: /^@sentry\/nextjs$/, replacement: fileURLToPath(new URL("./node_modules/@sentry/react/build/esm/index.js", import.meta.url)) },
            { find: "@mike/sentry-event", replacement: fileURLToPath(new URL("./src/shared/lib/sentryEvent.ts", import.meta.url)) },
            { find: "@mike/user-error", replacement: fileURLToPath(new URL("./src/shared/lib/userError.ts", import.meta.url)) },
            { find: "@mike/toast-store", replacement: fileURLToPath(new URL("./src/shared/lib/toastStore.ts", import.meta.url)) },
            { find: "@mike/toast-ui", replacement: fileURLToPath(new URL("./src/shared/ui/ToastUI.tsx", import.meta.url)) },
            { find: "@mike/secure-uuid", replacement: fileURLToPath(new URL("./src/shared/lib/secureUuid.ts", import.meta.url)) },
            {
                find: /^@mike\/upload-session-client$/,
                replacement: fileURLToPath(
                    new URL("./src/shared/api/uploadSessionClient.ts", import.meta.url),
                ),
            },
        ],
    },
    test: {
        environment: "jsdom",
        maxWorkers: process.env.CI ? undefined : localMaxWorkers,
        globals: false,
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
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
