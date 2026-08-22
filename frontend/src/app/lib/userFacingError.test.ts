import { describe, expect, it } from "vitest";
import { MikeApiError } from "./mikeApi";
import {
    knownErrorCodeMessage,
    userFacingApiError,
} from "./userFacingError";

describe("userFacingApiError", () => {
    it("allows intentional client-error details", () => {
        const error = new MikeApiError({
            status: 400,
            message: "The filename is required.",
        });

        expect(userFacingApiError(error, "Fallback")).toBe(
            "The filename is required.",
        );
    });

    it("does not expose server or plain exception messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({
                    status: 500,
                    message: "relation user_profiles does not exist",
                }),
                "Please try again.",
            ),
        ).toBe("Please try again.");
        expect(
            userFacingApiError(
                new Error("getaddrinfo ENOTFOUND internal-db"),
                "Please try again.",
            ),
        ).toBe("Please try again.");
    });
});

describe("knownErrorCodeMessage", () => {
    it("maps allowlisted codes and hides unknown ones", () => {
        const messages = { invalid_credentials: "Incorrect credentials." };
        expect(
            knownErrorCodeMessage(
                { code: "invalid_credentials" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Incorrect credentials.");
        expect(
            knownErrorCodeMessage(
                { code: "internal_provider_error" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });
});
