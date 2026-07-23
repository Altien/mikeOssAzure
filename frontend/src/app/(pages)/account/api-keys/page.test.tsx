import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import ApiKeysPage from "./page";

describe("organisation API key status", () => {
    it("shows provider status without exposing personal key controls", async () => {
        server.use(
            http.get("*/api/user/api-keys", () =>
                HttpResponse.json({
                    claude: true,
                    gemini: false,
                    openai: true,
                    kimi: true,
                    openrouter: false,
                    courtlistener: false,
                    sources: {
                        claude: "env",
                        gemini: null,
                        openai: "env",
                        kimi: "env",
                        openrouter: null,
                        courtlistener: null,
                    },
                }),
            ),
        );

        render(<ApiKeysPage />);

        expect(
            await screen.findAllByText("Configured for this organisation"),
        ).toHaveLength(3);
        expect(screen.getByText("Kimi K3")).toBeInTheDocument();
        expect(screen.getByText("Key Vault: moonshot-api-key")).toBeInTheDocument();
        expect(
            screen.getAllByText("Administrator action required").length,
        ).toBeGreaterThan(0);
        expect(
            screen.getByRole("link", { name: "Open organisation setup" }),
        ).toHaveAttribute("href", expect.stringContaining("/install"));
        expect(screen.queryByPlaceholderText("Token...")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();
    });
});
