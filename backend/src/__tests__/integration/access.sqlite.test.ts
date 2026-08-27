import { describe, expect, it } from "vitest";
import {
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../../lib/access";
import { createServerSQLite } from "../../lib/sqlite";

describe("SQLite access integration", () => {
    it("filters document IDs to documents the caller can access", async () => {
        const db = createServerSQLite();
        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const ownerId = crypto.randomUUID();
        const reviewerId = crypto.randomUUID();
        const reviewerEmail = `reviewer-${suffix}@example.com`;
        const sharedProjectId = crypto.randomUUID();
        const privateProjectId = crypto.randomUUID();
        const sharedDocId = crypto.randomUUID();
        const privateDocId = crypto.randomUUID();

        await db.from("projects").insert([
            {
                id: sharedProjectId,
                user_id: ownerId,
                name: `shared-${suffix}`,
                shared_with: [reviewerEmail],
            },
            {
                id: privateProjectId,
                user_id: ownerId,
                name: `private-${suffix}`,
                shared_with: [],
            },
        ]);
        await db.from("documents").insert([
            {
                id: sharedDocId,
                user_id: ownerId,
                project_id: sharedProjectId,
            },
            {
                id: privateDocId,
                user_id: ownerId,
                project_id: privateProjectId,
            },
        ]);

        try {
            await expect(
                listAccessibleProjectIds(reviewerId, reviewerEmail, db),
            ).resolves.toContain(sharedProjectId);

            await expect(
                filterAccessibleDocumentIds(
                    [sharedDocId, privateDocId],
                    reviewerId,
                    reviewerEmail,
                    db,
                ),
            ).resolves.toEqual([sharedDocId]);
        } finally {
            await db.from("documents").delete().in("id", [sharedDocId, privateDocId]);
            await db
                .from("projects")
                .delete()
                .in("id", [sharedProjectId, privateProjectId]);
        }
    });
});
