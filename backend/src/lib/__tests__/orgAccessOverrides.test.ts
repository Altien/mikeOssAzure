import { describe, expect, it } from "vitest";
import {
    isOrgAccessOverrideRole,
    setOrgAccessOverride,
} from "../orgAccessOverrides";

describe("organization access overrides", () => {
    it("accepts every explicit role plus Deny", () => {
        for (const role of ["owner", "editor", "viewer", "deny"]) {
            expect(isOrgAccessOverrideRole(role)).toBe(true);
        }
        expect(isOrgAccessOverrideRole("admin")).toBe(false);
        expect(isOrgAccessOverrideRole("member")).toBe(false);
    });

    it("persists an explicit Editor override for an organization Member", async () => {
        let written: Record<string, unknown> | null = null;
        let deleteCalled = false;
        let selectedTable: string | null = null;
        const db = {
            from: (table: string) => {
                selectedTable = table;
                return {
                    delete: () => {
                        deleteCalled = true;
                        return {};
                    },
                    upsert: (payload: Record<string, unknown>) => {
                        written = payload;
                        return {
                            select: () => ({
                                single: async () => ({
                                    data: {
                                        id: "override-1",
                                        user_id: payload.user_id,
                                        role: payload.role,
                                        assigned_by: payload.assigned_by,
                                        created_at: "2026-09-03T00:00:00Z",
                                        updated_at: payload.updated_at,
                                    },
                                    error: null,
                                }),
                            }),
                        };
                    },
                };
            },
        } as never;

        const result = await setOrgAccessOverride(db, {
            kind: "project",
            resourceId: "project-1",
            orgId: "org-1",
            userId: "member-2",
            role: "editor",
            assignedBy: "owner-1",
        });

        expect(deleteCalled).toBe(false);
        expect(written).toMatchObject({
            project_id: "project-1",
            org_id: "org-1",
            user_id: "member-2",
            role: "editor",
            assigned_by: "owner-1",
        });
        expect(result).toMatchObject({
            ok: true,
            override: { role: "editor" },
        });
        expect(selectedTable).toBe("project_org_access_overrides");
    });
});
