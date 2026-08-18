import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelToggle } from "./ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

function keys(configured: Partial<Record<keyof ApiKeyState, boolean>>) {
    const providers = [
        "claude",
        "gemini",
        "openai",
        "openrouter",
        "vercel",
        "courtlistener",
    ] as const;
    return Object.fromEntries(
        providers.map((provider) => [
            provider,
            {
                configured: configured[provider] ?? false,
                source: configured[provider] ? "user" : null,
            },
        ]),
    ) as ApiKeyState;
}

describe("ModelToggle responsive trigger", () => {
    it("uses the Settings2 icon in a compact chat input", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                compact
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveClass("w-8");
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger.querySelector("svg")).toBeInTheDocument();
    });

    it("allows a wider model label in the regular trigger", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        expect(screen.getByText("Gemini 3 Flash")).toHaveClass("max-w-[200px]");
    });
});

describe("ModelToggle availability states", () => {
    it("renders a neutral disabled trigger while keys are loading", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeysLoading
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        // The load-time flash: never claim "No API Key" before we know.
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("fails open when key state is unknown after a failed load", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeEnabled();
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("still reports No API Key when a LOADED state has no keys", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({})}
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        expect(trigger).toHaveTextContent("No API Key");
    });

    it("filters to configured providers when keys are loaded", () => {
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        // Claude has no key: the stored selection is not offered, so the
        // trigger falls back to the picker prompt.
        expect(
            screen.getByRole("button", { name: "Choose model" }),
        ).toHaveTextContent("Select model");
    });
});
