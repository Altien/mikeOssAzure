import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

// OSS-6: UserProfileContext is upstream's (204d2d53). /user/profile speaks
// upstream's camelCase `UserProfile` + `apiKeyStatus` (dev backend aligned in
// d451bc2e), the network goes through mikeApi (auth-token + /api; its
// plumbing is covered by lib/mikeApi.test.ts), and Azure OpenAI deployment
// discovery moved to src/altien/models/aoaiDeployments (own test). Dev's old
// cases for snake_case mapping, authedFetch, AOAI settings and the credits
// POST were retired with that code.

const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: mockUseAuth,
}));

vi.mock("@/app/lib/auth-token", () => ({
    getBrowserAccessToken: vi.fn().mockResolvedValue("tok-abc"),
    bounceIfUnauthorized: vi.fn(),
}));

import { UserProfileProvider, useUserProfile } from "./UserProfileContext";

const TEST_USER = { id: "u-1", email: "u@example.com" };

const PROFILE_FIXTURE = {
    displayName: "Test User",
    organisation: "Test Org",
    messageCreditsUsed: 5,
    creditsResetDate: "2026-12-01T00:00:00.000Z",
    creditsRemaining: 999994,
    tier: "Pro",
    titleModel: "aoai:title-deploy",
    tabularModel: "gemini-3-flash-preview",
    mfaOnLogin: false,
    legalResearchUs: true,
    darkMode: false,
    apiKeyStatus: {
        claude: false,
        gemini: true,
        openai: false,
        openrouter: false,
        courtlistener: false,
        kimi: true,
        azure_openai: true,
        sources: {
            claude: null,
            gemini: "env",
            openai: null,
            openrouter: null,
            courtlistener: null,
            kimi: "env",
            azure_openai: "env",
        },
    },
};

function authedFor(user: typeof TEST_USER | null) {
    mockUseAuth.mockReturnValue({
        user,
        isAuthenticated: user !== null,
        authLoading: false,
    });
}

type Captured = { method: string; url: string; body: unknown };

function serveProfile(
    profile: Record<string, unknown> = PROFILE_FIXTURE,
    captured: Captured[] = [],
) {
    server.use(
        http.get("*/api/user/profile", ({ request }) => {
            captured.push({ method: "GET", url: request.url, body: null });
            return HttpResponse.json(profile);
        }),
        http.patch("*/api/user/profile", async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            captured.push({ method: "PATCH", url: request.url, body });
            return HttpResponse.json({ ...profile, ...body });
        }),
    );
    return captured;
}

// Records the last update* return value for assertions.
function result(value: boolean) {
    document.body.dataset.result = String(value);
}

function Probe() {
    const ctx = useUserProfile();
    return (
        <div>
            <span data-testid="loading">{ctx.loading ? "loading" : "ready"}</span>
            <span data-testid="profile">
                {ctx.profile ? JSON.stringify(ctx.profile) : "null"}
            </span>
            <button onClick={async () => result(await ctx.updateDisplayName("Alice"))}>
                set-name
            </button>
            <button onClick={async () => result(await ctx.updateOrganisation("Acme"))}>
                set-org
            </button>
            <button
                onClick={async () =>
                    result(await ctx.updateModelPreference("titleModel", ""))
                }
            >
                clear-title
            </button>
            <button
                onClick={async () =>
                    result(await ctx.updateModelPreference("tabularModel", "gpt-5.4"))
                }
            >
                set-tabular
            </button>
            <button
                onClick={async () => result(await ctx.updateLegalResearchUs(false))}
            >
                legal-off
            </button>
            <button
                onClick={async () => result(await ctx.updateApiKey("claude", "  sk-x  "))}
            >
                set-claude
            </button>
            <button onClick={async () => result(await ctx.incrementMessageCredits())}>
                incr-credits
            </button>
            <button onClick={() => void ctx.reloadProfile()}>reload-profile</button>
            <button onClick={() => void ctx.updatePersonalisation({ professionalTitle: "Partner" })}>set-personalisation</button>
            <button onClick={() => void ctx.updateDarkMode(true)}>dark-on</button>
            <button onClick={() => void ctx.updateDarkMode(false)}>dark-off</button>
        </div>
    );
}

function renderProbe() {
    return render(
        <UserProfileProvider>
            <Probe />
        </UserProfileProvider>,
    );
}

function readProfile() {
    const raw = screen.getByTestId("profile").textContent ?? "null";
    return JSON.parse(raw);
}

async function waitReady() {
    await waitFor(() =>
        expect(screen.getByTestId("loading").textContent).toBe("ready"),
    );
}

beforeEach(() => {
    mockUseAuth.mockReset();
    delete document.body.dataset.result;
});

describe("UserProfileContext: bootstrap fetch on mount", () => {
    it("maps upstream's apiKeyStatus into per-provider apiKeys state", async () => {
        authedFor(TEST_USER);
        serveProfile();

        renderProbe();
        await waitReady();

        const profile = readProfile();
        expect(profile).toMatchObject({
            displayName: "Test User",
            organisation: "Test Org",
            messageCreditsUsed: 5,
            creditsRemaining: 999994,
            tier: "Pro",
            titleModel: "aoai:title-deploy",
            tabularModel: "gemini-3-flash-preview",
            mfaOnLogin: false,
            legalResearchUs: true,
        });
        expect(profile.apiKeyStatus).toBeUndefined();
        expect(profile.apiKeys).toEqual({
            claude: { configured: false, source: null },
            gemini: { configured: true, source: "env" },
            openai: { configured: false, source: null },
            openrouter: { configured: false, source: null },
            vercel: { configured: false, source: null },
            "opencode-go": { configured: false, source: null },
            courtlistener: { configured: false, source: null },
            // Dev (OSS-6 §2.3 item 3): organisation Kimi + Azure OpenAI.
            kimi: { configured: true, source: "env" },
            azure_openai: { configured: true, source: "env" },
        });
    });

    it("defaults a configured provider without a source to \"user\"", async () => {
        authedFor(TEST_USER);
        serveProfile({
            ...PROFILE_FIXTURE,
            apiKeyStatus: { ...PROFILE_FIXTURE.apiKeyStatus, sources: undefined },
        });

        renderProbe();
        await waitReady();

        expect(readProfile().apiKeys.gemini).toEqual({
            configured: true,
            source: "user",
        });
    });

    it("falls back to a 30-day Free profile when /user/profile fails", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.json({ detail: "boom" }, { status: 500 }),
            ),
        );

        renderProbe();
        await waitReady();

        const profile = readProfile();
        expect(profile).toMatchObject({
            tier: "Free",
            messageCreditsUsed: 0,
            creditsRemaining: 999999,
            legalResearchUs: true,
        });
        const reset = new Date(profile.creditsResetDate).getTime();
        expect(reset).toBeGreaterThan(Date.now() + 29 * 86_400_000);
        expect(profile.apiKeys.azure_openai).toEqual({
            configured: false,
            source: null,
        });
    });

    it("clears the profile and skips the network when unauthenticated", async () => {
        authedFor(null);
        // No handler registered: msw fails the test on any request.

        renderProbe();
        await waitReady();

        expect(screen.getByTestId("profile").textContent).toBe("null");
    });
});

describe("UserProfileContext: profile updates", () => {
    it("updateDisplayName PATCHes { displayName } and merges the response", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("set-name"));

        await waitFor(() =>
            expect(readProfile().displayName).toBe("Alice"),
        );
        const patch = captured.find((c) => c.method === "PATCH");
        expect(patch?.body).toEqual({ displayName: "Alice" });
        expect(patch?.url).toMatch(/\/api\/user\/profile$/);
        expect(document.body.dataset.result).toBe("true");
    });

    it("updateOrganisation PATCHes { organisation }", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("set-org"));

        await waitFor(() => expect(readProfile().organisation).toBe("Acme"));
        expect(captured.find((c) => c.method === "PATCH")?.body).toEqual({
            organisation: "Acme",
        });
    });

    it("updateModelPreference sends upstream's camelCase field (\"\" = no title preference)", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("clear-title"));
        await waitFor(() => expect(readProfile().titleModel).toBe(""));
        await userEvent.click(screen.getByText("set-tabular"));
        await waitFor(() => expect(readProfile().tabularModel).toBe("gpt-5.4"));

        const patches = captured.filter((c) => c.method === "PATCH");
        expect(patches.map((p) => p.body)).toEqual([
            { titleModel: "" },
            { tabularModel: "gpt-5.4" },
        ]);
    });

    it("updateLegalResearchUs PATCHes { legalResearchUs }", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("legal-off"));

        await waitFor(() => expect(readProfile().legalResearchUs).toBe(false));
        expect(captured.find((c) => c.method === "PATCH")?.body).toEqual({
            legalResearchUs: false,
        });
    });

    it("update* return false and leave state untouched when the PATCH fails", async () => {
        authedFor(TEST_USER);
        serveProfile();
        server.use(
            http.patch("*/api/user/profile", () =>
                HttpResponse.json({ detail: "nope" }, { status: 500 }),
            ),
        );
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("set-name"));

        await waitFor(() => expect(document.body.dataset.result).toBe("false"));
        expect(readProfile().displayName).toBe("Test User");
    });

    it("updateApiKey returns false when dev's backend rejects personal keys (403)", async () => {
        authedFor(TEST_USER);
        serveProfile();
        const puts: string[] = [];
        server.use(
            http.put("*/api/user/api-keys/:provider", async ({ request, params }) => {
                puts.push(`${params.provider}:${JSON.stringify(await request.json())}`);
                return HttpResponse.json(
                    { code: "organisation_api_key_required", detail: "managed" },
                    { status: 403 },
                );
            }),
        );
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("set-claude"));

        await waitFor(() => expect(document.body.dataset.result).toBe("false"));
        // Trimmed before sending (upstream behaviour).
        expect(puts).toEqual(['claude:{"api_key":"sk-x"}']);
        expect(readProfile().apiKeys.claude).toEqual({
            configured: false,
            source: null,
        });
    });

    it("incrementMessageCredits is a no-op that returns false (upstream)", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("incr-credits"));

        await waitFor(() => expect(document.body.dataset.result).toBe("false"));
        expect(captured.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("update functions short-circuit when there is no user", async () => {
        authedFor(null);
        renderProbe();
        await waitReady();

        await userEvent.click(screen.getByText("set-name"));

        await waitFor(() => expect(document.body.dataset.result).toBe("false"));
    });
});

describe("UserProfileContext: reloadProfile", () => {
    it("re-fetches the profile when invoked", async () => {
        authedFor(TEST_USER);
        const captured = serveProfile();
        renderProbe();
        await waitReady();
        expect(captured.filter((c) => c.method === "GET")).toHaveLength(1);

        await userEvent.click(screen.getByText("reload-profile"));

        await waitFor(() =>
            expect(captured.filter((c) => c.method === "GET")).toHaveLength(2),
        );
    });
});

describe("UserProfileContext: account and request fences", () => {
    it("saves dark mode and rolls back a rejected change", async () => {
        authedFor(TEST_USER);
        const bodies: unknown[] = [];
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                const body = await request.json() as { darkMode: boolean };
                bodies.push(body);
                return body.darkMode
                    ? HttpResponse.json({ ...PROFILE_FIXTURE, darkMode: true })
                    : HttpResponse.json({ error: "failed" }, { status: 500 });
            }),
        );
        renderProbe();
        await waitReady();
        fireEvent.click(screen.getByText("dark-on"));
        await waitFor(() => expect(readProfile().darkMode).toBe(true));
        await waitFor(() => expect(bodies).toEqual([{ darkMode: true }]));
        fireEvent.click(screen.getByText("dark-off"));
        await waitFor(() => expect(bodies).toHaveLength(2));
        await waitFor(() => expect(readProfile().darkMode).toBe(true));
    });
    it("ignores an old account fetch and a save response after identity changes", async () => {
        let releaseOldFetch!: (response: Response) => void;
        let releaseSave!: (response: Response) => void;
        const oldFetch = new Promise<Response>((resolve) => { releaseOldFetch = resolve; });
        const pendingSave = new Promise<Response>((resolve) => { releaseSave = resolve; });
        let fetchCount = 0;
        let patchCount = 0;
        server.use(
            http.get("*/api/user/profile", () => {
                fetchCount++;
                if (fetchCount === 1) return oldFetch;
                return HttpResponse.json({ ...PROFILE_FIXTURE, displayName: `User ${fetchCount}` });
            }),
            http.patch("*/api/user/profile", () => {
                patchCount++;
                return pendingSave;
            }),
        );
        authedFor(TEST_USER);
        const view = renderProbe();
        await waitFor(() => expect(fetchCount).toBe(1));

        authedFor({ id: "u-2", email: "two@example.com" });
        view.rerender(<UserProfileProvider><Probe /></UserProfileProvider>);
        await waitFor(() => expect(readProfile().displayName).toBe("User 2"));
        await act(async () => { releaseOldFetch(HttpResponse.json({ ...PROFILE_FIXTURE, displayName: "Old user" })); });
        expect(readProfile().displayName).toBe("User 2");

        fireEvent.click(screen.getByText("set-personalisation"));
        await waitFor(() => expect(patchCount).toBe(1));
        authedFor({ id: "u-3", email: "three@example.com" });
        view.rerender(<UserProfileProvider><Probe /></UserProfileProvider>);
        await waitFor(() => expect(readProfile().displayName).toBe("User 3"));
        await act(async () => { releaseSave(HttpResponse.json({ ...PROFILE_FIXTURE, displayName: "Stale save" })); });
        expect(readProfile().displayName).toBe("User 3");
    });
});

describe("UserProfileContext: useUserProfile outside a provider", () => {
    it("throws a clear error", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => render(<Probe />)).toThrow(
            "useUserProfile must be used within a UserProfileProvider",
        );
        spy.mockRestore();
    });
});
