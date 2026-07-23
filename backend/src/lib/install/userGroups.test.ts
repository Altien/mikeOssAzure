import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveUserGroups } from "./userGroups";

describe("install user group resolution", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("merges inline token groups with Microsoft Graph memberships", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    value: [
                        {
                            id: "33333333-3333-4333-8333-333333333333",
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            resolveUserGroups(
                {
                    oid: "11111111-1111-4111-8111-111111111111",
                    iat: 1_753_302_400,
                    groups: [
                        "22222222-2222-4222-8222-222222222222",
                        "44444444-4444-4444-8444-444444444444",
                    ],
                },
                "graph-access-token",
            ),
        ).resolves.toEqual([
            "22222222-2222-4222-8222-222222222222",
            "44444444-4444-4444-8444-444444444444",
            "33333333-3333-4333-8333-333333333333",
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://graph.microsoft.com/v1.0/me/memberOf?$select=id",
            {
                headers: {
                    Authorization: "Bearer graph-access-token",
                },
            },
        );
    });
});
