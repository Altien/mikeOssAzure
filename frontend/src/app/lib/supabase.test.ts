import { afterEach, describe, expect, it, vi } from "vitest";

// supabase.ts creates its client at module load, so each test re-imports the
// module fresh after adjusting the environment. vitest.config.mts supplies
// valid dummy env values; these tests override them per-case.

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("supabase client bootstrap", () => {
    it("exports a working client when both env vars are present", async () => {
        vi.resetModules();

        const { supabase } = await import("./supabase");

        expect(supabase.auth).toBeDefined();
        expect(typeof supabase.auth.getSession).toBe("function");
    });

    it("fails loudly at import when the Supabase URL is missing", async () => {
        // The `|| ""` fallback hands createClient an empty URL, which throws.
        // That is the desired behavior: a misconfigured build must crash at
        // startup, not mint a client that fails on every auth call later.
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.resetModules();

        await expect(import("./supabase")).rejects.toThrow(/supabaseUrl/i);
    });

    it("fails loudly at import when the publishable key is missing", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "");
        vi.resetModules();

        await expect(import("./supabase")).rejects.toThrow(/key/i);
    });
});
