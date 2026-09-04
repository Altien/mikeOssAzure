import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../../lib/access";

// Gated: runs only against a real (local) Supabase stack.
//   supabase start, then export:
//     SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY
// or use scripts/test-stack.sh which reads them from `supabase status`.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("Supabase access integration", () => {
    it("proves tabular document filtering drops foreign document IDs", async () => {
        const admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false },
        });
        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const ownerEmail = `owner-${suffix}@example.com`;
        const reviewerEmail = `reviewer-${suffix}@example.com`;
        let ownerId = "";
        let reviewerId = "";
        const sharedProjectId = crypto.randomUUID();
        const privateProjectId = crypto.randomUUID();
        const sharedDocId = crypto.randomUUID();
        const privateDocId = crypto.randomUUID();

        try {
            const owner = await admin.auth.admin.createUser({
                email: ownerEmail,
                password: "StackTest1!",
                email_confirm: true,
            });
            if (owner.error || !owner.data.user) {
                throw owner.error ?? new Error("Could not create owner");
            }
            ownerId = owner.data.user.id;

            const reviewer = await admin.auth.admin.createUser({
                email: reviewerEmail,
                password: "StackTest1!",
                email_confirm: true,
            });
            if (reviewer.error || !reviewer.data.user) {
                throw reviewer.error ?? new Error("Could not create reviewer");
            }
            reviewerId = reviewer.data.user.id;

            // Sharing is a `project_access_grants` row keyed on lowercase
            // email. Only the shared project receives a grant.
            const projectsInsert = await admin.from("projects").insert([
                {
                    id: sharedProjectId,
                    user_id: ownerId,
                    name: `shared-${suffix}`,
                },
                {
                    id: privateProjectId,
                    user_id: ownerId,
                    name: `private-${suffix}`,
                },
            ]);
            if (projectsInsert.error) {
                throw new Error(
                    `Could not seed projects: ${projectsInsert.error.message}`,
                    { cause: projectsInsert.error },
                );
            }

            const grantInsert = await admin
                .from("project_access_grants")
                .insert({
                    project_id: sharedProjectId,
                    email: reviewerEmail,
                    role: "editor",
                    created_by: ownerId,
                });
            if (grantInsert.error) {
                throw new Error(
                    `Could not seed access grant: ${grantInsert.error.message}`,
                    { cause: grantInsert.error },
                );
            }

            // filename/file_type live on document_versions in this schema —
            // the documents rows only need identity + ownership columns.
            const documentsInsert = await admin.from("documents").insert([
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
            if (documentsInsert.error) {
                throw new Error(
                    `Could not seed documents: ${documentsInsert.error.message}`,
                    { cause: documentsInsert.error },
                );
            }

            await expect(
                listAccessibleProjectIds(
                    reviewerId,
                    reviewerEmail,
                    admin as any,
                ),
            ).resolves.toContain(sharedProjectId);

            await expect(
                filterAccessibleDocumentIds(
                    [sharedDocId, privateDocId],
                    reviewerId,
                    reviewerEmail,
                    admin as any,
                ),
            ).resolves.toEqual([sharedDocId]);
        } finally {
            await admin.from("documents").delete().in("id", [sharedDocId, privateDocId]);
            await admin
                .from("projects")
                .delete()
                .in("id", [sharedProjectId, privateProjectId]);
            if (reviewerId) await admin.auth.admin.deleteUser(reviewerId);
            if (ownerId) await admin.auth.admin.deleteUser(ownerId);
        }
    });
});
