import type { User as SupabaseUser } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { authMethodState } from "./AuthContext";

describe("authMethodState", () => {
    it("identifies a Google-created account without a password", () => {
        expect(
            authMethodState({
                app_metadata: {
                    provider: "google",
                    providers: ["google"],
                },
                identities: [{ provider: "google" }],
            } as Pick<SupabaseUser, "app_metadata" | "identities">),
        ).toEqual({ createdWithGoogle: true, hasPassword: false });
    });

    it("detects email/password after it is added to a Google account", () => {
        expect(
            authMethodState({
                app_metadata: {
                    provider: "google",
                    providers: ["google", "email"],
                },
                identities: [
                    { provider: "google" },
                    { provider: "email" },
                ],
            } as Pick<SupabaseUser, "app_metadata" | "identities">),
        ).toEqual({ createdWithGoogle: true, hasPassword: true });
    });
});
