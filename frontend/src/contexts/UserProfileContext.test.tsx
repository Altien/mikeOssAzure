import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

// Mock useAuth so each test controls user / isAuthenticated / token
// without standing up the real AuthProvider.  bounceIfUnauthorized is
// mocked too because we only want to verify the SUT calls it — its
// own behaviour is covered by auth-token.test.ts.
const { mockUseAuth, mockBounceIfUnauthorized } = vi.hoisted(() => ({
    mockUseAuth: vi.fn(),
    mockBounceIfUnauthorized: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
    useAuth: mockUseAuth,
}));

vi.mock("@/lib/auth-token", () => ({
    bounceIfUnauthorized: mockBounceIfUnauthorized,
}));

import {
    UserProfileProvider,
    useUserProfile,
    type AzureOpenaiSettingsPatch,
} from "./UserProfileContext";

const TEST_USER = { id: "u-1", email: "u@example.com" };

const PROFILE_FIXTURE = {
    display_name: "Test User",
    organisation: "Test Org",
    message_credits_used: 5,
    credits_reset_date: "2026-06-01",
    tier: "Pro",
    tabular_model: "gemini-2.5-flash",
    fast_model: "claude-sonnet-4-6",
    claude_api_key: "sk-claude",
    gemini_api_key: null,
    openai_api_key: "sk-openai",
    azure_openai_endpoint: "https://example.openai.azure.com",
    azure_openai_api_key: "aoai-key",
    azure_openai_api_version: "2024-02-15",
    azure_openai_deployment: "gpt-4-turbo",
    global_api_keys: {
        claude: false,
        gemini: true,
        openai: false,
        azureOpenai: false,
    },
};

function authedFor(user: typeof TEST_USER | null) {
    mockUseAuth.mockReturnValue({
        user,
        isAuthenticated: user !== null,
        authLoading: false,
        signInLocal: vi.fn(),
        signOut: vi.fn(),
        getAccessToken: vi.fn().mockResolvedValue(user ? "tok-abc" : null),
    });
}

function Probe() {
    const ctx = useUserProfile();
    return (
        <div>
            <span data-testid="loading">{ctx.loading ? "loading" : "ready"}</span>
            <span data-testid="profile">
                {ctx.profile ? JSON.stringify(ctx.profile) : "null"}
            </span>
            <span data-testid="aoai-loading">
                {ctx.aoaiDeploymentsLoading ? "yes" : "no"}
            </span>
            <span data-testid="aoai-count">{ctx.aoaiDeployments.length}</span>
            <span data-testid="aoai-error">
                {ctx.aoaiDeploymentsError ?? "none"}
            </span>
            <span data-testid="aoai-names">
                {ctx.aoaiDeployments.map((d) => d.name).join(",")}
            </span>
            <button onClick={() => void ctx.updateDisplayName("Alice")}>
                set-name
            </button>
            <button onClick={() => void ctx.updateOrganisation("Acme")}>
                set-org
            </button>
            <button
                onClick={() =>
                    void ctx.updateModelPreference("tabularModel", "new-model")
                }
            >
                set-tabular
            </button>
            <button
                onClick={() =>
                    void ctx.updateModelPreference("fastModel", null)
                }
            >
                clear-fast
            </button>
            <button onClick={() => void ctx.updateApiKey("claude", "  sk-x  ")}>
                set-claude
            </button>
            <button onClick={() => void ctx.updateApiKey("gemini", "   ")}>
                clear-gemini
            </button>
            <button onClick={() => void ctx.updateApiKey("openai", null)}>
                null-openai
            </button>
            <button
                onClick={() =>
                    void ctx.updateAzureOpenaiSettings({
                        endpoint: "https://new.openai.azure.com",
                        apiKey: "   ",
                    })
                }
            >
                aoai-partial
            </button>
            <button
                onClick={() => void ctx.updateAzureOpenaiSettings({})}
            >
                aoai-empty
            </button>
            <button onClick={() => void ctx.reloadAoaiDeployments()}>
                reload-aoai
            </button>
            <button onClick={() => void ctx.incrementMessageCredits()}>
                incr-credits
            </button>
            <button onClick={() => void ctx.reloadProfile()}>
                reload-profile
            </button>
        </div>
    );
}

function defaultProfileHandlers() {
    return [
        http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
        http.get("*/api/llm/azure-openai/deployments", () =>
            HttpResponse.json({
                source: "personal",
                deployments: [
                    { name: "gpt-4-turbo", model: "gpt-4-turbo" },
                    { name: "gpt-35", model: "gpt-3.5-turbo" },
                ],
            }),
        ),
    ];
}

function profileJson() {
    return JSON.parse(screen.getByTestId("profile").textContent || "null");
}

beforeEach(() => {
    mockUseAuth.mockReset();
    mockBounceIfUnauthorized.mockReset();
});

describe("UserProfileContext: bootstrap fetch on mount", () => {
    it("maps the snake_case profile payload into the typed shape", async () => {
        authedFor(TEST_USER);
        server.use(...defaultProfileHandlers());

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        const profile = profileJson();
        expect(profile).toEqual({
            displayName: "Test User",
            organisation: "Test Org",
            messageCreditsUsed: 5,
            creditsResetDate: "2026-06-01",
            // monthlyCreditLimit (999999) - creditsUsed (5)
            creditsRemaining: 999994,
            tier: "Pro",
            // title_model / legal_research_us omitted from the fixture, so the
            // mapper falls back to its defaults.
            titleModel: "gemini-3.1-flash-lite-preview",
            tabularModel: "gemini-2.5-flash",
            fastModel: "claude-sonnet-4-6",
            legalResearchUs: true,
            claudeApiKey: "sk-claude",
            geminiApiKey: null,
            openaiApiKey: "sk-openai",
            azureOpenai: {
                endpoint: "https://example.openai.azure.com",
                apiKey: "aoai-key",
                apiVersion: "2024-02-15",
                deployment: "gpt-4-turbo",
            },
            globalApiKeys: {
                claude: false,
                gemini: true,
                openai: false,
                azureOpenai: false,
            },
        });
    });

    it("applies the default-tier fallback when the backend omits fields", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.json({
                    // Bare minimum — backend hasn't materialised the row yet.
                    credits_reset_date: "2026-06-01",
                }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        const profile = profileJson();
        // tier defaults to "Free"; tabular_model defaults to the
        // gemini preview SKU.  These are user-visible defaults — a
        // refactor changing them must update this test deliberately.
        expect(profile.tier).toBe("Free");
        expect(profile.tabularModel).toBe("gemini-3-flash-preview");
        // Credit math: 999999 - 0
        expect(profile.creditsRemaining).toBe(999999);
        // The boolean coercion on global_api_keys is the contract —
        // missing globals = all false (not undefined, not null).
        expect(profile.globalApiKeys).toEqual({
            claude: false,
            gemini: false,
            openai: false,
            azureOpenai: false,
        });
    });

    it("falls back to a 30-day offline-tier profile when /user/profile fails", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.text("server is down", { status: 500 }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        const profile = profileJson();
        expect(profile.tier).toBe("Free");
        expect(profile.creditsRemaining).toBe(999999);
        // creditsResetDate is "now + 30 days" — assert it's a future
        // ISO string we can parse, not the exact value.
        const reset = new Date(profile.creditsResetDate);
        const now = Date.now();
        expect(reset.getTime() - now).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
        expect(reset.getTime() - now).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    });

    it("clears profile + skips network when unauthenticated", async () => {
        authedFor(null);

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        // No bootstrap fetch — MSW has no handlers and would error on
        // unhandled.  The test passing confirms we never hit the wire.
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("profile")).toHaveTextContent("null");
        expect(screen.getByTestId("aoai-count")).toHaveTextContent("0");
    });
});

describe("UserProfileContext: authedFetch wiring", () => {
    it("injects Authorization: Bearer <token> from getAccessToken", async () => {
        authedFor(TEST_USER);
        let receivedAuth: string | null = null;
        server.use(
            http.get("*/api/user/profile", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return HttpResponse.json(PROFILE_FIXTURE);
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(receivedAuth).toBe("Bearer tok-abc");
    });

    it("omits Authorization when getAccessToken returns null", async () => {
        // Edge case: authenticated state is true but the token call
        // produced null (race or unusual provider).  authedFetch must
        // not send "Bearer null".
        mockUseAuth.mockReturnValue({
            user: TEST_USER,
            isAuthenticated: true,
            authLoading: false,
            signInLocal: vi.fn(),
            signOut: vi.fn(),
            getAccessToken: vi.fn().mockResolvedValue(null),
        });
        let receivedAuth: string | null = null;
        server.use(
            http.get("*/api/user/profile", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return HttpResponse.json(PROFILE_FIXTURE);
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(receivedAuth).toBeNull();
    });

    it("calls bounceIfUnauthorized on every response", async () => {
        authedFor(TEST_USER);
        server.use(...defaultProfileHandlers());

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        // At least the bootstrap profile + AOAI fetches both fired
        // through authedFetch, so the bounce guard ran at least twice.
        expect(mockBounceIfUnauthorized.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});

describe("UserProfileContext: AOAI deployments", () => {
    it("loads deployments on mount and exposes them through the context", async () => {
        authedFor(TEST_USER);
        server.use(...defaultProfileHandlers());

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("aoai-count")).toHaveTextContent("2"),
        );
        expect(screen.getByTestId("aoai-names")).toHaveTextContent(
            "gpt-4-turbo,gpt-35",
        );
        expect(screen.getByTestId("aoai-error")).toHaveTextContent("none");
    });

    it("records the error message on failure and resets the deployments list", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.text("aoai not configured", { status: 400 }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("aoai-error")).toHaveTextContent(
                "aoai not configured",
            ),
        );
        expect(screen.getByTestId("aoai-count")).toHaveTextContent("0");
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it("handles a response with no deployments key", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            // No `deployments` key — SUT falls back to []
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("aoai-count")).toHaveTextContent("0");
        expect(screen.getByTestId("aoai-error")).toHaveTextContent("none");
    });

    it("reloadAoaiDeployments re-fetches and clears the previous error", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        authedFor(TEST_USER);

        // First fetch: error. Second fetch: success.
        let callCount = 0;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.get("*/api/llm/azure-openai/deployments", () => {
                callCount += 1;
                if (callCount === 1) {
                    return HttpResponse.text("temporary", { status: 503 });
                }
                return HttpResponse.json({
                    source: "personal",
                    deployments: [{ name: "fresh", model: "gpt-4" }],
                });
            }),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("aoai-error")).toHaveTextContent("temporary"),
        );

        await userEvent.click(screen.getByText("reload-aoai"));

        await waitFor(() =>
            expect(screen.getByTestId("aoai-count")).toHaveTextContent("1"),
        );
        expect(screen.getByTestId("aoai-names")).toHaveTextContent("fresh");
        // Error was cleared at reload time.
        expect(screen.getByTestId("aoai-error")).toHaveTextContent("none");
        errSpy.mockRestore();
    });
});

describe("UserProfileContext: profile updates", () => {
    it("updateDisplayName PATCHes display_name and updates state on success", async () => {
        authedFor(TEST_USER);
        let receivedBody: unknown;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                receivedBody = await request.json();
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("set-name"));

        await waitFor(() => expect(profileJson().displayName).toBe("Alice"));
        expect(receivedBody).toEqual({ display_name: "Alice" });
    });

    it("updateDisplayName leaves state untouched when the PATCH fails", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", () =>
                HttpResponse.text("nope", { status: 400 }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("set-name"));
        // Give the async PATCH time to finish.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        // Display name stays at the fixture value, not "Alice".
        expect(profileJson().displayName).toBe("Test User");
    });

    it("updateOrganisation PATCHes organisation and updates state", async () => {
        authedFor(TEST_USER);
        let receivedBody: unknown;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                receivedBody = await request.json();
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("set-org"));

        await waitFor(() => expect(profileJson().organisation).toBe("Acme"));
        expect(receivedBody).toEqual({ organisation: "Acme" });
    });

    it("updateModelPreference maps the camelCase field to the DB column", async () => {
        authedFor(TEST_USER);
        const bodies: unknown[] = [];
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                bodies.push(await request.json());
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("set-tabular"));
        await waitFor(() =>
            expect(profileJson().tabularModel).toBe("new-model"),
        );

        await userEvent.click(screen.getByText("clear-fast"));
        await waitFor(() => expect(profileJson().fastModel).toBeNull());

        expect(bodies).toEqual([
            { tabular_model: "new-model" },
            { fast_model: null },
        ]);
    });

    it("updateApiKey trims whitespace and treats whitespace-only as null", async () => {
        authedFor(TEST_USER);
        const bodies: unknown[] = [];
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                bodies.push(await request.json());
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        // "  sk-x  " trims to "sk-x"
        await userEvent.click(screen.getByText("set-claude"));
        await waitFor(() => expect(profileJson().claudeApiKey).toBe("sk-x"));

        // "   " (whitespace only) becomes null — the "clear this key" UX.
        await userEvent.click(screen.getByText("clear-gemini"));
        await waitFor(() => expect(profileJson().geminiApiKey).toBeNull());

        // Explicit null — also null.
        await userEvent.click(screen.getByText("null-openai"));
        await waitFor(() => expect(profileJson().openaiApiKey).toBeNull());

        expect(bodies).toEqual([
            { claude_api_key: "sk-x" },
            { gemini_api_key: null },
            { openai_api_key: null },
        ]);
    });

    it("updateAzureOpenaiSettings: respects per-key membership and triggers a deployments reload", async () => {
        // Critical contract: only the keys present in the patch are
        // updated; absent keys are preserved.  The DB body must only
        // carry the patched keys, and the state azureOpenai object
        // must merge — not replace.
        authedFor(TEST_USER);
        const patchBodies: unknown[] = [];
        let deploymentsCallCount = 0;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                patchBodies.push(await request.json());
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () => {
                deploymentsCallCount += 1;
                return HttpResponse.json({ source: null, deployments: [] });
            }),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        // 1 deployments fetch fired at bootstrap.
        expect(deploymentsCallCount).toBe(1);

        // Patch: endpoint = new URL, apiKey = "   " (→ null).
        // apiVersion + deployment NOT in patch — must retain fixture values.
        await userEvent.click(screen.getByText("aoai-partial"));

        await waitFor(() =>
            expect(profileJson().azureOpenai.endpoint).toBe(
                "https://new.openai.azure.com",
            ),
        );
        const azure = profileJson().azureOpenai;
        expect(azure).toEqual({
            endpoint: "https://new.openai.azure.com",
            apiKey: null, // whitespace-only trimmed to null
            apiVersion: "2024-02-15", // retained from fixture
            deployment: "gpt-4-turbo", // retained from fixture
        });
        expect(patchBodies).toEqual([
            {
                azure_openai_endpoint: "https://new.openai.azure.com",
                azure_openai_api_key: null,
            },
        ]);

        // After a successful save we re-fetch the deployments list —
        // saving new credentials may unlock new deployments.
        await waitFor(() => expect(deploymentsCallCount).toBe(2));
    });

    it("updateAzureOpenaiSettings returns true and skips the PATCH on an empty patch", async () => {
        // Empty-patch fast-path: no network, no state change, success.
        authedFor(TEST_USER);
        const patches: unknown[] = [];
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", async ({ request }) => {
                patches.push(await request.json());
                return HttpResponse.json({});
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("aoai-empty"));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        // No PATCH was sent.
        expect(patches).toEqual([]);
    });

    it("update* return false when the PATCH rejects, leaving state untouched", async () => {
        // Covers the catch blocks on updateOrganisation,
        // updateModelPreference, updateApiKey, updateAzureOpenaiSettings.
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.patch("*/api/user/profile", () =>
                HttpResponse.text("bad request", { status: 400 }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        function Hook() {
            const ctx = useUserProfile();
            return (
                <button
                    onClick={async () => {
                        const a = await ctx.updateOrganisation("Acme");
                        const b = await ctx.updateModelPreference(
                            "tabularModel",
                            "x",
                        );
                        const c = await ctx.updateApiKey("claude", "y");
                        const d = await ctx.updateAzureOpenaiSettings({
                            endpoint: "z",
                        });
                        const el = document.createElement("span");
                        el.dataset.testid = "fail-results";
                        el.textContent = `${a},${b},${c},${d}`;
                        document.body.appendChild(el);
                    }}
                >
                    try-all-fail
                </button>
            );
        }

        render(
            <UserProfileProvider>
                <Probe />
                <Hook />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );
        const initial = profileJson();

        await userEvent.click(screen.getByText("try-all-fail"));
        await waitFor(() =>
            expect(screen.getByTestId("fail-results")).toHaveTextContent(
                "false,false,false,false",
            ),
        );

        // Profile object did not mutate on any of the failed updates.
        expect(profileJson()).toEqual(initial);
    });

    it("incrementMessageCredits returns false when the POST rejects", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.post("*/api/user/profile/credits/increment", () =>
                HttpResponse.text("bad", { status: 500 }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        function Hook() {
            const ctx = useUserProfile();
            return (
                <button
                    onClick={async () => {
                        const result = await ctx.incrementMessageCredits();
                        const el = document.createElement("span");
                        el.dataset.testid = "incr-result";
                        el.textContent = String(result);
                        document.body.appendChild(el);
                    }}
                >
                    incr-failing
                </button>
            );
        }

        render(
            <UserProfileProvider>
                <Probe />
                <Hook />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("incr-failing"));
        await waitFor(() =>
            expect(screen.getByTestId("incr-result")).toHaveTextContent("false"),
        );

        // No state mutation.
        expect(profileJson().messageCreditsUsed).toBe(5);
    });

    it("incrementMessageCredits returns false when called before the profile loads", async () => {
        // Covers the `!profile` branch of the guard.  We exercise this
        // by calling the function during the loading window — before
        // the bootstrap fetch resolves.
        authedFor(TEST_USER);
        let releaseProfile!: (value: unknown) => void;
        const profileGate = new Promise((r) => {
            releaseProfile = r;
        });
        server.use(
            http.get("*/api/user/profile", async () => {
                await profileGate;
                return HttpResponse.json(PROFILE_FIXTURE);
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        function Hook() {
            const ctx = useUserProfile();
            return (
                <button
                    onClick={async () => {
                        const result = await ctx.incrementMessageCredits();
                        const el = document.createElement("span");
                        el.dataset.testid = "incr-early";
                        el.textContent = String(result);
                        document.body.appendChild(el);
                    }}
                >
                    incr-early
                </button>
            );
        }

        render(
            <UserProfileProvider>
                <Hook />
            </UserProfileProvider>,
        );

        // Profile is still loading; call increment.
        await userEvent.click(screen.getByText("incr-early"));
        await waitFor(() =>
            expect(screen.getByTestId("incr-early")).toHaveTextContent("false"),
        );

        // Release the stalled handler so the harness teardown doesn't hang.
        await act(async () => {
            releaseProfile(undefined);
            await new Promise((r) => setTimeout(r, 0));
        });
    });

    it("update functions short-circuit when there is no user", async () => {
        // Even if the context is rendered (the page got past the
        // unauthenticated guard for a brief frame), the update
        // closures captured `user = null` and must refuse rather
        // than send a misattributed PATCH.
        let sawPatch = false;
        server.use(
            http.patch("*/api/user/profile", () => {
                sawPatch = true;
                return HttpResponse.json({});
            }),
        );
        authedFor(null);

        function Hook() {
            const { updateDisplayName, updateApiKey, updateAzureOpenaiSettings } =
                useUserProfile();
            return (
                <div>
                    <button
                        onClick={async () => {
                            const a = await updateDisplayName("x");
                            const b = await updateApiKey("claude", "y");
                            const c = await updateAzureOpenaiSettings({
                                endpoint: "z",
                            } satisfies AzureOpenaiSettingsPatch);
                            const el = document.createElement("span");
                            el.dataset.testid = "results";
                            el.textContent = `${a},${b},${c}`;
                            document.body.appendChild(el);
                        }}
                    >
                        try-all
                    </button>
                </div>
            );
        }

        render(
            <UserProfileProvider>
                <Hook />
            </UserProfileProvider>,
        );

        await userEvent.click(screen.getByText("try-all"));
        await waitFor(() =>
            expect(screen.getByTestId("results")).toHaveTextContent(
                "false,false,false",
            ),
        );
        expect(sawPatch).toBe(false);
    });
});

describe("UserProfileContext: incrementMessageCredits", () => {
    it("POSTs and updates messageCreditsUsed + creditsRemaining", async () => {
        authedFor(TEST_USER);
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(PROFILE_FIXTURE)),
            http.post("*/api/user/profile/credits/increment", () =>
                HttpResponse.json({ message_credits_used: 6 }),
            ),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("incr-credits"));

        await waitFor(() =>
            expect(profileJson().messageCreditsUsed).toBe(6),
        );
        expect(profileJson().creditsRemaining).toBe(999993);
    });

    it("returns false without POSTing when the user has no credits remaining", async () => {
        authedFor(TEST_USER);
        let sawIncrement = false;
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.json({
                    ...PROFILE_FIXTURE,
                    message_credits_used: 999999, // remaining = 0
                }),
            ),
            http.post("*/api/user/profile/credits/increment", () => {
                sawIncrement = true;
                return HttpResponse.json({ message_credits_used: 1_000_000 });
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );
        expect(profileJson().creditsRemaining).toBe(0);

        await userEvent.click(screen.getByText("incr-credits"));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        // No POST fired — the 0-credits guard wins before authedFetch.
        expect(sawIncrement).toBe(false);
        // State unchanged.
        expect(profileJson().messageCreditsUsed).toBe(999999);
    });
});

describe("UserProfileContext: reloadProfile", () => {
    it("re-fetches the profile when invoked", async () => {
        authedFor(TEST_USER);
        let callCount = 0;
        server.use(
            http.get("*/api/user/profile", () => {
                callCount += 1;
                return HttpResponse.json({
                    ...PROFILE_FIXTURE,
                    display_name: callCount === 1 ? "First" : "Second",
                });
            }),
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({ source: null, deployments: [] }),
            ),
        );

        render(
            <UserProfileProvider>
                <Probe />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(profileJson().displayName).toBe("First"),
        );

        await userEvent.click(screen.getByText("reload-profile"));

        await waitFor(() =>
            expect(profileJson().displayName).toBe("Second"),
        );
        expect(callCount).toBe(2);
    });
});

describe("UserProfileContext: useUserProfile outside a provider", () => {
    it("throws a clear error", () => {
        function Bare() {
            useUserProfile();
            return null;
        }

        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => render(<Bare />)).toThrow(
            /useUserProfile must be used within a UserProfileProvider/,
        );
        errSpy.mockRestore();
    });
});
