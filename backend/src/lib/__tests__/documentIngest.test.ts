import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDocumentFromBytes } from "../documentIngest";
import { createServerSQLite } from "../sqlite";
import { downloadFile, storageKey } from "../storage";

describe("createDocumentFromBytes", () => {
    it("deletes uploaded bytes when version registration fails", async () => {
        const userId = crypto.randomUUID();
        const realDb = createServerSQLite();
        const filename = "report.md";
        const content = Buffer.from("# Hello\n\nWorld.", "utf8");

        // Wrap the real db so document_versions inserts fail after the
        // source bytes have already been uploaded.
        const failingDb = {
            from(table: string) {
                if (table === "document_versions") {
                    return {
                        insert: () => ({
                            select: () => ({
                                single: async () => ({
                                    data: null,
                                    error: new Error("forced version failure"),
                                }),
                            }),
                        }),
                    };
                }
                return realDb.from(table);
            },
        } as unknown as ReturnType<typeof createServerSQLite>;

        const result = await createDocumentFromBytes({
            userId,
            projectId: null,
            filename,
            content,
            db: failingDb,
            libraryKind: "file",
        });

        expect(result.ok).toBe(false);

        // The document row was created before the upload; find it and
        // confirm the source bytes are gone from storage.
        const { data: docs } = await realDb
            .from("documents")
            .select("id, status")
            .eq("user_id", userId);
        expect(docs).toHaveLength(1);
        const docId = docs![0].id as string;
        expect(docs![0].status).toBe("error");
        const key = storageKey(userId, docId, filename);
        await expect(downloadFile(key)).resolves.toBeNull();

        await realDb.from("documents").delete().eq("id", docId);
    });
});
