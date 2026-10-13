import { describe, expect, it } from "vitest";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
} from "../user.dataExport";
import { makeExportDb, type Row } from "./user.dataExport.fixture";

const userId = "departed-user";
const email = "departed@example.test";
const resource = (id: string, fields: Row = {}): Row => ({
    id,
    user_id: userId,
    project_id: null,
    org_id: null,
    archived_at: null,
    ...fields,
});
const ids = (rows: Row[]) => rows.map((row) => row.id);

function fixtures(): Record<string, Row[]> {
    const scopes = ["personal", "current", "departed", "denied", "archived"];
    const scoped = (kind: string) => scopes.map((scope) => resource(`${kind}-${scope}`, {
        org_id: scope === "personal" ? null : scope === "departed" ? "old-org" : "current-org",
        archived_at: scope === "archived" ? "2026-10-13T00:00:00Z" : null,
        ...(scope === "denied" ? { project_id: "project-denied" } : {}),
    }));
    const projects: Row[] = scoped("project").map((row) => ({
        ...row,
        project_id: undefined,
        user_id: row.id === "project-denied" ? "colleague" : userId,
        visibility: "organization",
    }));
    const reviews = scoped("review");
    const chats = scoped("chat");
    const documents = [
        ...scoped("document"),
        resource("document-departed-project", { project_id: "project-departed", org_id: "old-org" }),
        resource("document-departed-workflow", { workflow_id: "workflow-departed", org_id: "old-org" }),
        resource("document-current-project", { project_id: "project-current", org_id: "current-org", user_id: "colleague" }),
    ];
    return {
        organizations: [{ id: "old-org", kind: "team" }, { id: "current-org", kind: "team" }],
        org_members: [{ org_id: "current-org", user_id: userId, role: "member" }],
        project_org_access_overrides: [{ project_id: "project-denied", org_id: "current-org", user_id: userId, role: "deny" }],
        projects,
        project_subfolders: projects.map((row) => ({ id: `folder-${row.id}`, project_id: row.id })),
        workflows: [
            resource("workflow-personal"),
            resource("workflow-current", { org_id: "current-org" }),
            resource("workflow-departed", { org_id: "old-org" }),
            resource("workflow-archived", { org_id: "current-org", archived_at: "2026-10-13T00:00:00Z" }),
        ],
        documents,
        document_versions: documents.map((row) => ({ id: `version-${row.id}`, document_id: row.id })),
        document_edits: documents.map((row) => ({ id: `edit-${row.id}`, document_id: row.id })),
        chats,
        chat_messages: chats.map((row) => ({ id: `message-${row.id}`, chat_id: row.id })),
        tabular_reviews: reviews,
        tabular_cells: reviews.map((row) => ({ id: `cell-${row.id}`, review_id: row.id })),
        tabular_review_chats: [
            ...reviews.map((row) => resource(`thread-${row.id}`, { review_id: row.id })),
            resource("orphan-thread", { review_id: "missing-review" }),
        ],
        tabular_review_chat_messages: reviews.map((row) => ({ id: `message-${row.id}`, chat_id: `thread-${row.id}` })),
    };
}

describe("exports enforce current read access", () => {
    it("excludes departed, denied and archived content and its descendants from account exports", async () => {
        const { db } = makeExportDb(fixtures());
        const result = await buildUserAccountExport(db, userId, email);

        expect(ids(result.projects)).toEqual(["project-personal", "project-current"]);
        expect(ids(result.project_subfolders)).toEqual(["folder-project-personal", "folder-project-current"]);
        expect(ids(result.workflows)).toEqual(["workflow-personal", "workflow-current"]);
        expect(ids(result.documents)).toEqual(["document-personal", "document-current", "document-current-project"]);
        expect(ids(result.document_versions)).toEqual(["version-document-personal", "version-document-current", "version-document-current-project"]);
        expect(ids(result.document_edits)).toEqual(["edit-document-personal", "edit-document-current", "edit-document-current-project"]);
        expect(ids(result.chats.chats)).toEqual(["chat-personal", "chat-current"]);
        expect(ids(result.chats.messages)).toEqual(["message-chat-personal", "message-chat-current"]);
        expect(ids(result.tabular_reviews)).toEqual(["review-personal", "review-current"]);
        expect(ids(result.tabular_cells)).toEqual(["cell-review-personal", "cell-review-current"]);
        expect(ids(result.tabular_review_chats.chats)).toEqual(["thread-review-personal", "thread-review-current"]);
        expect(ids(result.tabular_review_chats.messages)).toEqual(["message-review-personal", "message-review-current"]);
    });

    it("applies the same rules to chat-only and review-only exports", async () => {
        const { db } = makeExportDb(fixtures());
        const chats = await buildUserChatsExport(db, userId, email);
        const reviews = await buildUserTabularReviewsExport(db, userId, email);

        expect(ids(chats.assistant_chats.chats)).toEqual(["chat-personal", "chat-current"]);
        expect(ids(chats.assistant_chats.messages)).toEqual(["message-chat-personal", "message-chat-current"]);
        expect(ids(chats.tabular_review_chats.chats)).toEqual(["thread-review-personal", "thread-review-current"]);
        expect(ids(chats.tabular_review_chats.messages)).toEqual(["message-review-personal", "message-review-current"]);
        expect(ids(reviews.tabular_reviews)).toEqual(["review-personal", "review-current"]);
        expect(ids(reviews.tabular_cells)).toEqual(["cell-review-personal", "cell-review-current"]);
        expect(ids(reviews.tabular_review_chats.chats)).toEqual(["thread-review-personal", "thread-review-current"]);
        expect(ids(reviews.tabular_review_chats.messages)).toEqual(["message-review-personal", "message-review-current"]);
    });

    it("keeps accessible shared review transcripts and excludes them after membership or sharing is revoked", async () => {
        const tables: Record<string, Row[]> = {
            organizations: [{ id: "org", kind: "team" }],
            org_members: [{ org_id: "org", user_id: userId, role: "member" }],
            tabular_reviews: [resource("shared-review", { user_id: "colleague", org_id: "org" })],
            tabular_review_access_grants: [{ tabular_review_id: "shared-review", email, role: "viewer" }],
            tabular_review_chats: [resource("thread", { review_id: "shared-review" })],
            tabular_review_chat_messages: [{ id: "message", chat_id: "thread", content: "Retained team discussion" }],
        };
        const { db } = makeExportDb(tables);
        const before = await buildUserChatsExport(db, userId, email);
        expect(ids(before.tabular_review_chats.messages)).toEqual(["message"]);

        tables.org_members = [];
        tables.tabular_review_chat_messages.push({ id: "after-removal", chat_id: "thread", content: "Written after removal" });
        const after = await buildUserChatsExport(db, userId, email);
        const account = await buildUserAccountExport(db, userId, email);
        expect(after.tabular_review_chats).toEqual({ chats: [], messages: [] });
        expect(account.tabular_review_chats).toEqual({ chats: [], messages: [] });
        expect(account.shared_access.tabular_reviews).toEqual([]);

        tables.org_members = [{ org_id: "org", user_id: userId, role: "member" }];
        tables.tabular_review_access_grants = [];
        expect((await buildUserChatsExport(db, userId, email)).tabular_review_chats).toEqual({ chats: [], messages: [] });
    });

    it("does not treat stale direct project grants as organization membership", async () => {
        const { db } = makeExportDb({
            projects: [resource("team-project", { user_id: "colleague", org_id: "departed-org", visibility: "organization" })],
            project_access_grants: [{ project_id: "team-project", email, role: "owner" }],
        });
        expect((await buildUserAccountExport(db, userId, email)).shared_access.projects).toEqual([]);
    });

    it("keeps personal data without an email, including Word transcripts", async () => {
        const { db } = makeExportDb({
            chats: [resource("personal-chat")],
            chat_messages: [{ id: "personal-message", chat_id: "personal-chat" }],
            word_documents: [resource("word-doc")],
            word_chats: [resource("word-chat", { word_document_id: "word-doc" })],
            word_chat_messages: [{ id: "word-message", chat_id: "word-chat" }],
        });
        const result = await buildUserChatsExport(db, userId);
        expect(ids(result.assistant_chats.messages)).toEqual(["personal-message"]);
        expect(ids(result.word_addin_chats.messages)).toEqual(["word-message"]);
    });

    it("fails closed when organization membership or scope cannot be read", async () => {
        const tables = fixtures();
        const membershipFailure = makeExportDb(tables, { org_members: { message: "unavailable" } });
        const result = await buildUserChatsExport(membershipFailure.db, userId, email);
        expect(ids(result.assistant_chats.chats)).toEqual(["chat-personal"]);
        expect(ids(result.tabular_review_chats.chats)).toEqual(["thread-review-personal"]);

        const scopeFailure = makeExportDb(tables, { organizations: { message: "unavailable" } });
        await expect(buildUserChatsExport(scopeFailure.db, userId, email)).rejects.toThrow("Failed to read the organization's kind");
    });
});
