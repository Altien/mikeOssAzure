import { afterEach, describe, expect, it, vi } from "vitest";

describe("Connectors page bootstrap", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("loads when the API base URL is empty for a same-origin deployment", async () => {
        vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

        await expect(import("./page")).resolves.toHaveProperty("default");
    });
});
