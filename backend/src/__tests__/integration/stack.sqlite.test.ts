import { describe, expect, it } from "vitest";
import { checkProjectAccess } from "../../lib/access";
import { createServerSQLite } from "../../lib/sqlite";

describe("SQLite stack integration", () => {
    it("generates UUID ids when Supabase-defaulted inserts omit them", async () => {
        const db = createServerSQLite();
        const userId = crypto.randomUUID();
        const inserted = await db.from("support_feedback").insert({
            user_id: userId,
            type: "bug",
            subject: "Generated id contract",
            message: "Test",
        });
        const id = String(inserted.data?.[0]?.id ?? "");
        try {
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            );
            const stored = await db
                .from("support_feedback")
                .select("id")
                .eq("id", id)
                .maybeSingle();
            expect(stored.data?.id).toBe(id);
        } finally {
            if (id) await db.from("support_feedback").delete().eq("id", id);
        }
    });

    it("persists project rows and enforces owner/shared access semantics", async () => {
        const db = createServerSQLite();
        const ownerId = crypto.randomUUID();
        const strangerId = crypto.randomUUID();
        const projectId = crypto.randomUUID();
        const sharedEmail = `shared-${Date.now()}@example.com`;

        await db.from("projects").insert({
            id: projectId,
            user_id: ownerId,
            name: "Stack Test Project",
            shared_with: [sharedEmail],
        });

        try {
            await expect(
                checkProjectAccess(projectId, ownerId, "owner@example.com", db),
            ).resolves.toMatchObject({ ok: true, isOwner: true });

            await expect(
                checkProjectAccess(projectId, strangerId, sharedEmail, db),
            ).resolves.toMatchObject({ ok: true, isOwner: false });

            await expect(
                checkProjectAccess(
                    projectId,
                    strangerId,
                    "stranger@example.com",
                    db,
                ),
            ).resolves.toEqual({ ok: false });
        } finally {
            await db.from("projects").delete().eq("id", projectId);
        }
    });
});
