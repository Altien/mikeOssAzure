import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// OSS-6: dev's EmailPillInput (free-form email pills) was replaced upstream by
// AddUserInput, which resolves each email against GET /user/lookup before
// handing a known user to `onAdd`. Retargeted from EmailPillInput.test.

const { lookupUserByEmailMock } = vi.hoisted(() => ({
    lookupUserByEmailMock: vi.fn(),
}));

// Dev drift: AddUserInput now maps errors via userFacingApiError, which needs
// the real MikeApiError / reportedUpstreamMessage exports.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    lookupUserByEmail: lookupUserByEmailMock,
}));

import { AddUserInput } from "./AddUserInput";
import { MikeApiError } from "@/app/lib/mikeApi";

beforeEach(() => {
    lookupUserByEmailMock.mockReset();
    lookupUserByEmailMock.mockImplementation(async (email: string) => ({
        exists: true,
        email,
        display_name: "Alice",
    }));
});

describe("AddUserInput", () => {
    it("renders the default placeholder, or a custom one", () => {
        const { unmount } = render(<AddUserInput onAdd={() => {}} />);
        expect(screen.getByPlaceholderText("Add by email...")).toBeInTheDocument();
        unmount();

        render(<AddUserInput onAdd={() => {}} placeholder="Invite by email" />);
        expect(screen.getByPlaceholderText("Invite by email")).toBeInTheDocument();
    });

    it("shows the Add button only once something is typed", async () => {
        render(<AddUserInput onAdd={() => {}} />);
        expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();

        await userEvent.type(screen.getByPlaceholderText("Add by email..."), "a");
        expect(screen.getByRole("button", { name: /Add/ })).toBeInTheDocument();
    });

    it("Enter looks up the email (lowercased + trimmed), calls onAdd, and clears the input", async () => {
        const onAdd = vi.fn();
        render(<AddUserInput onAdd={onAdd} />);
        const input = screen.getByPlaceholderText("Add by email...");

        await userEvent.type(input, "  ALICE@example.com  {Enter}");

        await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
        expect(lookupUserByEmailMock).toHaveBeenCalledWith("alice@example.com");
        expect(onAdd).toHaveBeenCalledWith({
            exists: true,
            email: "alice@example.com",
            display_name: "Alice",
        });
        expect(input).toHaveValue("");
    });

    it("comma also commits (UX shortcut)", async () => {
        const onAdd = vi.fn();
        render(<AddUserInput onAdd={onAdd} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "bob@example.com,",
        );

        await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
        expect(lookupUserByEmailMock).toHaveBeenCalledWith("bob@example.com");
    });

    it("rejects an invalid email without a lookup", async () => {
        const onAdd = vi.fn();
        render(<AddUserInput onAdd={onAdd} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "not-an-email{Enter}",
        );

        expect(await screen.findByText("Enter a valid email.")).toBeInTheDocument();
        expect(lookupUserByEmailMock).not.toHaveBeenCalled();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("reports an email that does not belong to a user", async () => {
        lookupUserByEmailMock.mockResolvedValueOnce({
            exists: false,
            email: "ghost@example.com",
            display_name: null,
        });
        const onAdd = vi.fn();
        render(<AddUserInput onAdd={onAdd} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "ghost@example.com{Enter}",
        );

        expect(
            await screen.findByText("ghost@example.com does not belong to a Mike user."),
        ).toBeInTheDocument();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("a validateEmail error blocks the lookup", async () => {
        const onAdd = vi.fn();
        render(
            <AddUserInput
                onAdd={onAdd}
                validateEmail={(email) =>
                    email === "me@example.com" ? "You already have access." : null
                }
            />,
        );

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "me@example.com{Enter}",
        );

        expect(await screen.findByText("You already have access.")).toBeInTheDocument();
        expect(lookupUserByEmailMock).not.toHaveBeenCalled();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("surfaces a lookup failure message", async () => {
        // Dev drift: upstream a104acce sanitizes errors — only intentional 4xx
        // MikeApiError messages are shown verbatim.
        lookupUserByEmailMock.mockRejectedValueOnce(
            new MikeApiError({ message: "Lookup failed", status: 404 }),
        );
        render(<AddUserInput onAdd={() => {}} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "alice@example.com{Enter}",
        );

        expect(await screen.findByText("Lookup failed")).toBeInTheDocument();
    });

    it("hides a raw transport error behind the generic fallback", async () => {
        lookupUserByEmailMock.mockRejectedValueOnce(new Error("ECONNRESET internals"));
        render(<AddUserInput onAdd={() => {}} />);

        await userEvent.type(
            screen.getByPlaceholderText("Add by email..."),
            "alice@example.com{Enter}",
        );

        expect(
            await screen.findByText("Could not add this user. Try again."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/ECONNRESET/)).toBeNull();
    });
});
