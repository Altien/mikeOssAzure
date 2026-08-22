import type { User as SupabaseUser } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { authMethodState } from "./AuthContext";

describe("authMethodState", () => {
    it("identifies a Google-created account", () => {
        expect(
            authMethodState({
                app_metadata: {
                    provider: "google",
                    providers: ["google"],
                },
                identities: [{ provider: "google" }],
            } as Pick<SupabaseUser, "app_metadata">),
        ).toEqual({ createdWithGoogle: true });
    });

    it("does not infer password state from provider metadata", () => {
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
            } as Pick<SupabaseUser, "app_metadata">),
        ).toEqual({ createdWithGoogle: true });
    });
});
