import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

// Azure OpenAI deployment discovery (OSS-6 §2.3 item 3). These cases moved
// here from dev's pre-OSS-6 UserProfileContext.test when discovery left the
// (now upstream) profile context.

const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: mockUseAuth,
}));

vi.mock("@/app/lib/auth-token", () => ({
    getBrowserAccessToken: vi.fn().mockResolvedValue("tok-abc"),
    bounceIfUnauthorized: vi.fn(),
}));

import {
    AoaiDeploymentsProvider,
    toAoaiModelOptions,
    useAoaiDeployments,
} from "./aoaiDeployments";

function authedFor(user: { id: string; email: string } | null) {
    mockUseAuth.mockReturnValue({
        user,
        isAuthenticated: user !== null,
        authLoading: false,
    });
}

function Probe() {
    const ctx = useAoaiDeployments();
    return (
        <div>
            <span data-testid="loading">{ctx.loading ? "yes" : "no"}</span>
            <span data-testid="count">{ctx.deployments.length}</span>
            <span data-testid="error">{ctx.error ?? "none"}</span>
            <span data-testid="ids">
                {ctx.modelOptions.map((o) => o.id).join(",")}
            </span>
            <button onClick={() => void ctx.reload()}>reload</button>
        </div>
    );
}

function renderProbe() {
    return render(
        <AoaiDeploymentsProvider>
            <Probe />
        </AoaiDeploymentsProvider>,
    );
}

beforeEach(() => {
    mockUseAuth.mockReset();
    authedFor({ id: "u-1", email: "u@example.com" });
});

describe("AoaiDeploymentsProvider", () => {
    it("loads deployments on mount and exposes them as aoai: model options", async () => {
        server.use(
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json({
                    source: "global",
                    deployments: [
                        { name: "gpt-4-turbo", model: "gpt-4" },
                        { name: "gpt-35", model: null },
                    ],
                }),
            ),
        );

        renderProbe();

        await waitFor(() =>
            expect(screen.getByTestId("count")).toHaveTextContent("2"),
        );
        expect(screen.getByTestId("ids")).toHaveTextContent(
            "aoai:gpt-4-turbo,aoai:gpt-35",
        );
        expect(screen.getByTestId("error")).toHaveTextContent("none");
    });

    it("records the error message on failure and resets the list", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get("*/api/llm/azure-openai/deployments", () =>
                HttpResponse.json(
                    { detail: "aoai not configured" },
                    { status: 400 },
                ),
            ),
        );

        renderProbe();

        await waitFor(() =>
            expect(screen.getByTestId("error")).toHaveTextContent(
                "aoai not configured",
            ),
        );
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it("handles a response with no deployments key", async () => {
        let calls = 0;
        server.use(
            http.get("*/api/llm/azure-openai/deployments", () => {
                calls += 1;
                return HttpResponse.json({ source: null });
            }),
        );

        renderProbe();

        await waitFor(() => expect(calls).toBe(1));
        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("no"),
        );
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        expect(screen.getByTestId("error")).toHaveTextContent("none");
    });

    it("reload re-fetches and clears the previous error", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let calls = 0;
        server.use(
            http.get("*/api/llm/azure-openai/deployments", () => {
                calls += 1;
                if (calls === 1) {
                    return HttpResponse.json(
                        { detail: "temporary" },
                        { status: 503 },
                    );
                }
                return HttpResponse.json({
                    source: "global",
                    deployments: [{ name: "fresh", model: "gpt-4" }],
                });
            }),
        );

        renderProbe();
        await waitFor(() =>
            expect(screen.getByTestId("error")).toHaveTextContent("temporary"),
        );

        await userEvent.click(screen.getByText("reload"));

        await waitFor(() =>
            expect(screen.getByTestId("count")).toHaveTextContent("1"),
        );
        expect(screen.getByTestId("ids")).toHaveTextContent("aoai:fresh");
        expect(screen.getByTestId("error")).toHaveTextContent("none");
        errSpy.mockRestore();
    });

    it("skips the network when unauthenticated", async () => {
        authedFor(null);
        // No handler: msw fails the test on any request.
        renderProbe();

        expect(screen.getByTestId("count")).toHaveTextContent("0");
        expect(screen.getByTestId("loading")).toHaveTextContent("no");
    });
});

describe("useAoaiDeployments without a provider", () => {
    it("returns an empty, non-throwing value", () => {
        render(<Probe />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        expect(screen.getByTestId("error")).toHaveTextContent("none");
    });
});

describe("toAoaiModelOptions", () => {
    it("labels by deployment name with the base model as a hint", () => {
        expect(
            toAoaiModelOptions([
                { name: "prod-gpt", model: "gpt-5.4" },
                { name: "bare", model: null },
            ]),
        ).toEqual([
            { id: "aoai:prod-gpt", label: "prod-gpt (gpt-5.4)", group: "Azure OpenAI" },
            { id: "aoai:bare", label: "bare", group: "Azure OpenAI" },
        ]);
    });
});
