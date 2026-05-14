import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailPillInput } from "./EmailPillInput";

describe("EmailPillInput", () => {
    it("renders the placeholder when no emails are present", () => {
        render(<EmailPillInput emails={[]} onChange={() => {}} />);

        expect(
            screen.getByPlaceholderText("Add by email…"),
        ).toBeInTheDocument();
    });

    it("uses a custom placeholder when supplied", () => {
        render(
            <EmailPillInput
                emails={[]}
                onChange={() => {}}
                placeholder="Invite by email"
            />,
        );

        expect(
            screen.getByPlaceholderText("Invite by email"),
        ).toBeInTheDocument();
    });

    it("renders one pill per email + the remove button", () => {
        render(
            <EmailPillInput
                emails={["alice@example.com", "bob@example.com"]}
                onChange={() => {}}
            />,
        );

        expect(screen.getByText("alice@example.com")).toBeInTheDocument();
        expect(screen.getByText("bob@example.com")).toBeInTheDocument();
        // Each pill has its own remove button (the trailing X icon).
        expect(screen.getAllByRole("button")).toHaveLength(2);
    });

    it("Enter adds a valid email — lowercased + trimmed", async () => {
        const onChange = vi.fn();
        render(<EmailPillInput emails={[]} onChange={onChange} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "  ALICE@example.com  {Enter}",
        );

        expect(onChange).toHaveBeenCalledWith(["alice@example.com"]);
    });

    it("comma also commits the email (UX shortcut)", async () => {
        const onChange = vi.fn();
        render(<EmailPillInput emails={[]} onChange={onChange} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "alice@example.com,",
        );

        expect(onChange).toHaveBeenCalledWith(["alice@example.com"]);
    });

    it("rejects a malformed email with an inline error", async () => {
        const onChange = vi.fn();
        render(<EmailPillInput emails={[]} onChange={onChange} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "not-an-email{Enter}",
        );

        expect(onChange).not.toHaveBeenCalled();
        expect(
            screen.getByText("Enter a valid email address."),
        ).toBeInTheDocument();
    });

    it("silently dedupes an email already in the list", async () => {
        const onChange = vi.fn();
        render(
            <EmailPillInput
                emails={["alice@example.com"]}
                onChange={onChange}
            />,
        );

        await userEvent.type(
            screen.getByPlaceholderText(""),
            "alice@example.com{Enter}",
        );

        // No state change; no inline error either.
        expect(onChange).not.toHaveBeenCalled();
        expect(
            screen.queryByText("Enter a valid email address."),
        ).not.toBeInTheDocument();
    });

    it("Backspace on an empty input removes the trailing pill", async () => {
        const onChange = vi.fn();
        render(
            <EmailPillInput
                emails={["alice@example.com", "bob@example.com"]}
                onChange={onChange}
            />,
        );

        await userEvent.type(screen.getByPlaceholderText(""), "{Backspace}");

        expect(onChange).toHaveBeenCalledWith(["alice@example.com"]);
    });

    it("Backspace does nothing when the input has text (preserve text)", async () => {
        const onChange = vi.fn();
        render(
            <EmailPillInput
                emails={["alice@example.com"]}
                onChange={onChange}
            />,
        );

        const input = screen.getByPlaceholderText("");
        await userEvent.type(input, "bo");
        await userEvent.type(input, "{Backspace}");

        // No pill removal — onChange not called with a shrunken list.
        expect(onChange).not.toHaveBeenCalled();
    });

    it("clicking a pill's X removes that email", async () => {
        const onChange = vi.fn();
        render(
            <EmailPillInput
                emails={["alice@example.com", "bob@example.com"]}
                onChange={onChange}
            />,
        );

        const removeButtons = screen.getAllByRole("button");
        await userEvent.click(removeButtons[0]); // Alice's X

        expect(onChange).toHaveBeenCalledWith(["bob@example.com"]);
    });

    it("runs the async validate hook + shows the returned error string", async () => {
        const onChange = vi.fn();
        const validate = vi
            .fn()
            .mockResolvedValue("User not in your organisation");
        const onValidatingChange = vi.fn();
        render(
            <EmailPillInput
                emails={[]}
                onChange={onChange}
                validate={validate}
                onValidatingChange={onValidatingChange}
            />,
        );

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "ghost@nope.com{Enter}",
        );

        await waitFor(() =>
            expect(
                screen.getByText("User not in your organisation"),
            ).toBeInTheDocument(),
        );
        expect(validate).toHaveBeenCalledWith("ghost@nope.com");
        expect(onChange).not.toHaveBeenCalled();
        // The validating flag toggles true → false around the call.
        expect(onValidatingChange).toHaveBeenCalledWith(true);
        expect(onValidatingChange).toHaveBeenLastCalledWith(false);
    });

    it("validate hook resolving with null lets the email through", async () => {
        const onChange = vi.fn();
        const validate = vi.fn().mockResolvedValue(null);
        render(
            <EmailPillInput
                emails={[]}
                onChange={onChange}
                validate={validate}
            />,
        );

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "ok@example.com{Enter}",
        );

        await waitFor(() =>
            expect(onChange).toHaveBeenCalledWith(["ok@example.com"]),
        );
    });

    it("validate hook throwing shows a generic 'Could not verify' fallback", async () => {
        const onChange = vi.fn();
        const validate = vi.fn().mockRejectedValue(new Error("network"));
        render(
            <EmailPillInput
                emails={[]}
                onChange={onChange}
                validate={validate}
            />,
        );

        await userEvent.type(
            screen.getByPlaceholderText("Add by email…"),
            "x@y.com{Enter}",
        );

        await waitFor(() =>
            expect(
                screen.getByText("Could not verify email. Try again."),
            ).toBeInTheDocument(),
        );
        expect(onChange).not.toHaveBeenCalled();
    });
});
