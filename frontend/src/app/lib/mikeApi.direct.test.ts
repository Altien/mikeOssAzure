import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("@/app/lib/auth");
});

describe("direct backend API transport", () => {
    it("preserves local-provider bearer authentication", async () => {
        vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:3001");
        vi.doMock("@/app/lib/auth", () => ({
            getAuthToken: vi.fn().mockResolvedValue("local-token"),
        }));

        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ tier: "free" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const { API_BASE, getUserProfile } = await import("./mikeApi");
        await getUserProfile();

        expect(API_BASE).toBe("http://localhost:3001");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://localhost:3001/user/profile");
        expect(new Headers(init.headers).get("Authorization")).toBe(
            "Bearer local-token",
        );
        expect(init.credentials).toBe("include");
    });
});
