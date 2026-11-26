import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelToggleUI, type ModelToggleOption } from "./ModelToggleUI";

const models: ModelToggleOption[] = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Anthropic" },
];

describe("ModelToggleUI as a form field", () => {
    it("can be a grey flat field, like a flat select", () => {
        render(
            <ModelToggleUI
                value="claude-opus-5-5"
                onChange={vi.fn()}
                models={models}
                selectedLabel="Claude Opus 5.5"
                selectedAvailable
                modalInput="flat"
            />,
        );
        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveTextContent("Claude Opus 5.5");
        expect(trigger).toHaveClass("w-full", "bg-app-surface-active", "rounded-xl");
    });

    it("keeps the glass field by default", () => {
        render(
            <ModelToggleUI
                value="claude-opus-5-5"
                onChange={vi.fn()}
                models={models}
                selectedLabel="Claude Opus 5.5"
                selectedAvailable
                modalInput
            />,
        );
        expect(screen.getByRole("button", { name: "Choose model" })).not.toHaveClass(
            "bg-app-surface-active",
        );
    });

    it("shows the selected model's notice in the open menu and on the trigger", async () => {
        const user = userEvent.setup();
        const notice = { tag: "Free", text: "The provider keeps your prompts." };
        render(
            <ModelToggleUI
                value="managed/free"
                onChange={vi.fn()}
                models={[...models, { id: "managed/free", label: "Free Model", group: "Managed", notice }]}
            />,
        );
        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveTextContent("Free");
        expect(trigger.getAttribute("title")).toContain(notice.text);

        await user.click(trigger);
        expect(screen.getByRole("note")).toHaveTextContent(notice.text);
        expect(screen.getByRole("menu")).toHaveAccessibleDescription(notice.text);
        expect(screen.getByRole("menuitem", { name: /Free Model/ })).toHaveTextContent("Free");
    });

    it("shows no notice while a model without one is selected", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggleUI
                value="claude-opus-5-5"
                onChange={vi.fn()}
                models={[
                    ...models,
                    { id: "managed/free", label: "Free Model", group: "Anthropic", notice: { tag: "Free", text: "Kept." } },
                ]}
            />,
        );
        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger.getAttribute("title")).not.toContain("Kept.");
        await user.click(trigger);
        expect(screen.queryByRole("note")).not.toBeInTheDocument();
        // The free row is still tagged in the list.
        expect(screen.getByRole("menuitem", { name: /Free Model/ })).toHaveTextContent("Free");
    });

    it("shows the empty state flat too", () => {
        render(<ModelToggleUI value="" onChange={vi.fn()} models={[]} modalInput="flat" onEmptyClick={vi.fn()} />);
        expect(screen.getByRole("button", { name: "No models available" })).toHaveClass(
            "bg-app-surface-active",
        );
    });
});
