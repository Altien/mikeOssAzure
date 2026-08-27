import { afterEach, describe, expect, it, vi } from "vitest";

// supabase.ts creates its client lazily so the local-auth profile does not
// require Supabase configuration. Each test resets the module cache after
// adjusting the environment.

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("supabase client bootstrap", () => {
    it("exports a working client when both env vars are present", async () => {
        vi.resetModules();

        const { getBrowserSupabase } = await import("./supabase");
        const supabase = getBrowserSupabase();

        expect(supabase.auth).toBeDefined();
        expect(typeof supabase.auth.getSession).toBe("function");
    });

    it("fails loudly when the Supabase URL is missing", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.resetModules();

        const { getBrowserSupabase } = await import("./supabase");
        expect(() => getBrowserSupabase()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/i);
    });

    it("fails loudly when the publishable key is missing", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "");
        vi.resetModules();

        const { getBrowserSupabase } = await import("./supabase");
        expect(() => getBrowserSupabase()).toThrow(
            /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY/i,
        );
    });

    it("returns the same client instance on repeated calls", async () => {
        vi.resetModules();

        const { getBrowserSupabase } = await import("./supabase");

        expect(getBrowserSupabase()).toBe(getBrowserSupabase());
    });

    it("treats unset env vars the same as empty strings", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", undefined);
        vi.resetModules();

        const { getBrowserSupabase } = await import("./supabase");
        expect(() => getBrowserSupabase()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/i);
    });
});
