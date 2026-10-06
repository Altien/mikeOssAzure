import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [tsconfigPaths(), react()],
    resolve: {
        // Upstream #450 test (src/wordAddin/client.test.ts) imports Word add-in
        // source outside this root, where tsconfigPaths() does not apply the
        // frontend paths; mirror upstream's explicit alias for the shared client.
        alias: [
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
