import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "./ApiKeyField";

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn().mockResolvedValue(false),
}));

function renderField(hasSavedKey: boolean) {
    const onSave = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn().mockResolvedValue(true);
    render(
        <ApiKeyField
            label="Google (Gemini) API Key"
            placeholder="AIza..."
            hasSavedKey={hasSavedKey}
            onSave={onSave}
            onRemove={onRemove}
        />,
    );
    const input = screen.getByLabelText(
        "Google (Gemini) API Key",
    ) as HTMLInputElement;
    return { input, onSave, onRemove };
}

describe("ApiKeyField", () => {
    it("shows a masked value when a key is saved", () => {
        const { input } = renderField(true);

        expect(input.type).toBe("password");
        expect(input.value.length).toBeGreaterThan(0);
        expect(input.readOnly).toBe(true);
        expect(screen.queryByText("Saved key hidden")).toBeNull();
    });

    it("shows an empty input with the placeholder when no key is saved", () => {
        const { input } = renderField(false);

        expect(input.value).toBe("");
        expect(input.placeholder).toBe("AIza...");
        expect(input.readOnly).toBe(false);
    });

    it("clears the mask on focus so a replacement key can be entered", async () => {
        const user = userEvent.setup();
        const { input, onSave } = renderField(true);

        await user.click(input);
        expect(input.value).toBe("");
        expect(input.readOnly).toBe(false);

        await user.type(input, "new-key");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(onSave).toHaveBeenCalledWith("new-key");
    });

    it("restores the mask when focus leaves without a new key", async () => {
        const user = userEvent.setup();
        const { input } = renderField(true);

        await user.click(input);
        await user.tab();

        expect(input.value.length).toBeGreaterThan(0);
        expect(input.readOnly).toBe(true);
    });
});
