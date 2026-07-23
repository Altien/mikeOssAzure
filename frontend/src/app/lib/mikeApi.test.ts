import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

// Mock auth-token at the module boundary so each test controls the
// token + can assert bounceIfUnauthorized was invoked on the response.
const { mockGetBrowserAccessToken, mockBounceIfUnauthorized } = vi.hoisted(
    () => ({
        mockGetBrowserAccessToken: vi.fn(),
        mockBounceIfUnauthorized: vi.fn(),
    }),
);

vi.mock("@/lib/auth-token", () => ({
    getBrowserAccessToken: mockGetBrowserAccessToken,
    bounceIfUnauthorized: mockBounceIfUnauthorized,
}));

import {
    listProjects,
    createProject,
    updateProject,
    deleteProject,
    deleteAccount,
    getUserProfile,
    updateUserProfile,
    getApiKeyStatus,
    saveApiKey,
    uploadProjectDocument,
    uploadStandaloneDocument,
    downloadDocumentsZip,
    listChats,
    getChat,
    listProjectChats,
    renameChat,
    deleteChat,
    generateChatTitle,
    streamChat,
    streamProjectChat,
    listTabularReviews,
    getDocumentUrl,
    mapTRMessages,
    getProject,
    getProjectPeople,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveSubfolderToFolder,
    moveDocumentToFolder,
    addDocumentToProject,
    listDocumentVersions,
    uploadDocumentVersion,
    renameDocumentVersion,
    listStandaloneDocuments,
    deleteDocument,
    createChat,
    createTabularReview,
    getTabularReview,
    updateTabularReview,
    getTabularReviewPeople,
    generateTabularColumnPrompt,
    deleteTabularReview,
    streamTabularGeneration,
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    regenerateTabularCell,
    clearTabularCells,
    listWorkflows,
    getWorkflow,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
    listHiddenWorkflows,
    hideWorkflow,
    unhideWorkflow,
    shareWorkflow,
    listWorkflowShares,
    deleteWorkflowShare,
    uploadReviewDocument,
} from "./mikeApi";

beforeEach(() => {
    mockGetBrowserAccessToken.mockReset().mockResolvedValue("tok-abc");
    mockBounceIfUnauthorized.mockReset();
});

describe("mikeApi: apiRequest wrapper — URL + headers + auth", () => {
    it("constructs URLs as API_BASE + path", async () => {
        let requestedPath: string | null = null;
        server.use(
            http.get("*/api/projects", ({ request }) => {
                requestedPath = new URL(request.url).pathname;
                return HttpResponse.json([]);
            }),
        );

        await listProjects();

        expect(requestedPath).toBe("/api/projects");
    });

    it("injects Authorization: Bearer <token>", async () => {
        let receivedAuth: string | null = null;
        server.use(
            http.get("*/api/projects", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return HttpResponse.json([]);
            }),
        );

        await listProjects();

        expect(receivedAuth).toBe("Bearer tok-abc");
    });

    it("omits Authorization when getBrowserAccessToken returns null", async () => {
        mockGetBrowserAccessToken.mockResolvedValue(null);
        let receivedAuth: string | null = "(default)";
        server.use(
            http.get("*/api/projects", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return HttpResponse.json([]);
            }),
        );

        await listProjects();

        expect(receivedAuth).toBeNull();
    });

    it("sends Accept: application/json by default", async () => {
        let receivedAccept: string | null = null;
        server.use(
            http.get("*/api/projects", ({ request }) => {
                receivedAccept = request.headers.get("Accept");
                return HttpResponse.json([]);
            }),
        );

        await listProjects();

        expect(receivedAccept).toBe("application/json");
    });

    it("allows callers to override headers (e.g. add Content-Type for POSTs)", async () => {
        let contentType: string | null = null;
        server.use(
            http.post("*/api/projects", ({ request }) => {
                contentType = request.headers.get("Content-Type");
                return HttpResponse.json({ id: "p", name: "n" });
            }),
        );

        await createProject("n");

        // createProject explicitly sets Content-Type; the wrapper's
        // default headers must NOT clobber it.
        expect(contentType).toBe("application/json");
    });

    it("calls bounceIfUnauthorized on every response", async () => {
        server.use(http.get("*/api/projects", () => HttpResponse.json([])));

        await listProjects();

        expect(mockBounceIfUnauthorized).toHaveBeenCalledOnce();
    });
});

describe("mikeApi: apiRequest wrapper — body parsing", () => {
    it("returns the parsed JSON body on 2xx", async () => {
        const fixture = [{ id: "p1", name: "Project 1" }];
        server.use(http.get("*/api/projects", () => HttpResponse.json(fixture)));

        const result = await listProjects();

        expect(result).toEqual(fixture);
    });

    it("returns undefined on 204 (no content)", async () => {
        server.use(
            http.delete("*/api/projects/:id", () =>
                new HttpResponse(null, { status: 204 }),
            ),
        );

        // deleteProject's return type is void — undefined satisfies it.
        await expect(deleteProject("p1")).resolves.toBeUndefined();
    });

    it("returns undefined when Content-Length is 0 (some backends send 200 + empty body)", async () => {
        server.use(
            http.delete("*/api/projects/:id", () =>
                new HttpResponse("", {
                    status: 200,
                    headers: { "Content-Length": "0" },
                }),
            ),
        );

        await expect(deleteProject("p1")).resolves.toBeUndefined();
    });
});

describe("mikeApi: apiRequest wrapper — error envelope", () => {
    it("throws the response text on non-2xx (backend-provided detail wins)", async () => {
        server.use(
            http.get("*/api/projects", () =>
                HttpResponse.text("Quota exceeded: 1000 requests/hour", {
                    status: 429,
                }),
            ),
        );

        await expect(listProjects()).rejects.toThrow(
            "Quota exceeded: 1000 requests/hour",
        );
    });

    it("falls back to a generic message when the response body is empty", async () => {
        // Some load-balancers strip the body on 5xx; the wrapper
        // must still produce an informative error.
        server.use(
            http.get("*/api/projects", () =>
                new HttpResponse(null, { status: 502 }),
            ),
        );

        await expect(listProjects()).rejects.toThrow("API error: 502");
    });
});

describe("mikeApi: project endpoints", () => {
    it("createProject POSTs the right body shape", async () => {
        let received: unknown;
        server.use(
            http.post("*/api/projects", async ({ request }) => {
                received = await request.json();
                return HttpResponse.json({ id: "new", name: "Acme" });
            }),
        );

        const project = await createProject("Acme", "CM-1234", [
            "alice@example.com",
        ]);

        expect(received).toEqual({
            name: "Acme",
            cm_number: "CM-1234",
            shared_with: ["alice@example.com"],
        });
        expect(project).toEqual({ id: "new", name: "Acme" });
    });

    it("createProject omits undefined fields from the body", async () => {
        // JSON.stringify drops undefined values — assert that
        // contract so a refactor doesn't accidentally send `null` and
        // change backend semantics.
        let received: Record<string, unknown> = {};
        server.use(
            http.post("*/api/projects", async ({ request }) => {
                received = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({ id: "p", name: "n" });
            }),
        );

        await createProject("Solo");

        expect(received.name).toBe("Solo");
        expect("cm_number" in received).toBe(false);
        expect("shared_with" in received).toBe(false);
    });

    it("updateProject PATCHes with the correct path + body", async () => {
        let method: string | null = null;
        let path: string | null = null;
        let body: unknown;
        server.use(
            http.patch("*/api/projects/:id", async ({ request, params }) => {
                method = request.method;
                path = String(params.id);
                body = await request.json();
                return HttpResponse.json({ id: "p1", name: "Renamed" });
            }),
        );

        await updateProject("p1", { name: "Renamed", cm_number: "CM-1" });

        expect(method).toBe("PATCH");
        expect(path).toBe("p1");
        expect(body).toEqual({ name: "Renamed", cm_number: "CM-1" });
    });

    it("deleteProject hits DELETE /api/projects/:id and resolves on 204", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/projects/:id", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );

        await deleteProject("p1");

        expect(method).toBe("DELETE");
    });
});

describe("mikeApi: user / account endpoints", () => {
    it("deleteAccount DELETEs /user/account", async () => {
        let method: string | null = null;
        let path: string | null = null;
        server.use(
            http.delete("*/api/user/account", ({ request }) => {
                method = request.method;
                path = new URL(request.url).pathname;
                return new HttpResponse(null, { status: 204 });
            }),
        );

        await deleteAccount();

        expect(method).toBe("DELETE");
        expect(path).toBe("/api/user/account");
    });

    it("getUserProfile / updateUserProfile / getApiKeyStatus / saveApiKey wire to the right paths + verbs", async () => {
        const calls: { method: string; path: string; body?: unknown }[] = [];
        const PROFILE_FIXTURE = {
            displayName: "User",
            organisation: null,
            messageCreditsUsed: 0,
            creditsResetDate: "2026-06-01",
            creditsRemaining: 100,
            tier: "Free",
            tabularModel: "gemini-3-flash-preview",
            apiKeyStatus: {
                claude: false,
                gemini: false,
                openai: false,
            },
        };
        server.use(
            http.get("*/api/user/profile", ({ request }) => {
                calls.push({
                    method: "GET",
                    path: new URL(request.url).pathname,
                });
                return HttpResponse.json(PROFILE_FIXTURE);
            }),
            http.patch("*/api/user/profile", async ({ request }) => {
                calls.push({
                    method: "PATCH",
                    path: new URL(request.url).pathname,
                    body: await request.json(),
                });
                return HttpResponse.json({
                    ...PROFILE_FIXTURE,
                    displayName: "New Name",
                });
            }),
            http.get("*/api/user/api-keys", ({ request }) => {
                calls.push({
                    method: "GET",
                    path: new URL(request.url).pathname,
                });
                return HttpResponse.json({
                    claude: true,
                    gemini: false,
                    openai: true,
                });
            }),
            // saveApiKey is PUT to /api/user/api-keys/:provider (NOT POST,
            // NOT /api/user/api-keys with provider-in-body).  Pin the
            // verb + URL shape so a refactor that "normalises" to POST
            // breaks loudly.
            http.put("*/api/user/api-keys/:provider", async ({ request, params }) => {
                calls.push({
                    method: "PUT",
                    path: `/api/user/api-keys/${params.provider}`,
                    body: await request.json(),
                });
                return HttpResponse.json({
                    claude: true,
                    gemini: false,
                    openai: true,
                });
            }),
        );

        const profile = await getUserProfile();
        expect(profile.displayName).toBe("User");
        expect(profile.tier).toBe("Free");

        const updated = await updateUserProfile({
            displayName: "New Name",
            tabularModel: "gpt-5",
        });
        expect(updated.displayName).toBe("New Name");

        const status = await getApiKeyStatus();
        expect(status.claude).toBe(true);

        await saveApiKey("openai", "sk-fresh");

        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            "GET /api/user/profile",
            "PATCH /api/user/profile",
            "GET /api/user/api-keys",
            "PUT /api/user/api-keys/openai",
        ]);
        // updateUserProfile body uses camelCase keys (NOT the snake_case
        // the UserProfileContext uses for its own /api/user/profile
        // fetch).  This API client is a separate convenience layer.
        expect(calls[1].body).toEqual({
            displayName: "New Name",
            tabularModel: "gpt-5",
        });
        // saveApiKey body shape pin: { api_key: <value> }.
        expect(calls[3].body).toEqual({ api_key: "sk-fresh" });
    });
});

describe("mikeApi: file uploads (FormData)", () => {
    it("uploadProjectDocument POSTs multipart with the file and no Content-Type override", async () => {
        let contentType: string | null = null;
        let path: string | null = null;
        let hasFileField = false;
        server.use(
            http.post("*/api/projects/:id/documents", async ({ request, params }) => {
                contentType = request.headers.get("Content-Type");
                path = `/api/projects/${params.id}/documents`;
                const form = await request.formData();
                // jsdom + MSW v2 don't reliably expose the File's
                // `name` through formData().get(...).name; assert on
                // field presence + the multipart Content-Type instead.
                hasFileField = form.has("file");
                return HttpResponse.json({ id: "d-1", filename: "doc.pdf" });
            }),
        );

        const file = new File(["%PDF-1.4..."], "doc.pdf", {
            type: "application/pdf",
        });
        const result = await uploadProjectDocument("p-1", file);

        expect(path).toBe("/api/projects/p-1/documents");
        // The SUT does NOT set Content-Type — fetch derives it from
        // FormData so the boundary is correct.  Asserting on the
        // resulting header confirms multipart was used.
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(hasFileField).toBe(true);
        expect(result).toEqual({ id: "d-1", filename: "doc.pdf" });
    });

    it("uploadStandaloneDocument POSTs to /single-documents", async () => {
        let path: string | null = null;
        server.use(
            http.post("*/api/single-documents", async ({ request }) => {
                path = new URL(request.url).pathname;
                await request.formData();
                return HttpResponse.json({ id: "d-2", filename: "f.docx" });
            }),
        );

        await uploadStandaloneDocument(
            new File([""], "f.docx", {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }),
        );

        expect(path).toBe("/api/single-documents");
    });

    it("uploadProjectDocument throws the response text on non-2xx", async () => {
        server.use(
            http.post("*/api/projects/:id/documents", () =>
                HttpResponse.text("file too large", { status: 413 }),
            ),
        );

        await expect(
            uploadProjectDocument("p-1", new File([""], "x.pdf")),
        ).rejects.toThrow("file too large");
    });
});

describe("mikeApi: streaming chat helpers", () => {
    it("streamChat POSTs to /chat with Accept: text/event-stream + the AbortSignal", async () => {
        let method: string | null = null;
        let accept: string | null = null;
        let body: unknown;
        server.use(
            http.post("*/api/chat", async ({ request }) => {
                method = request.method;
                accept = request.headers.get("Accept");
                body = await request.json();
                return new HttpResponse("data: [DONE]\n\n", {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );

        const controller = new AbortController();
        const response = await streamChat({
            messages: [{ role: "user", content: "hi" }],
            chat_id: "c-1",
            model: "gpt-5",
            signal: controller.signal,
        });

        expect(method).toBe("POST");
        expect(accept).toBe("text/event-stream");
        // The signal field is destructured out and NOT included in the body.
        expect(body).toEqual({
            messages: [{ role: "user", content: "hi" }],
            chat_id: "c-1",
            model: "gpt-5",
        });
        // The returned Response is a streaming body, not parsed JSON —
        // that's the contract the caller (useAssistantChat) relies on.
        expect(response.body).toBeInstanceOf(ReadableStream);
        expect(mockBounceIfUnauthorized).toHaveBeenCalledWith(response);
    });

    it("streamProjectChat URL contains the projectId and the body omits it", async () => {
        let path: string | null = null;
        let body: Record<string, unknown> = {};
        server.use(
            http.post(
                "*/api/projects/:projectId/chat",
                async ({ request, params }) => {
                    path = `/api/projects/${params.projectId}/chat`;
                    body = (await request.json()) as Record<string, unknown>;
                    return new HttpResponse("data: [DONE]\n\n", {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                },
            ),
        );

        await streamProjectChat({
            projectId: "p-99",
            messages: [{ role: "user", content: "review" }],
            displayed_doc: { filename: "x.pdf", document_id: "d-1" },
        });

        expect(path).toBe("/api/projects/p-99/chat");
        // projectId is consumed for the URL only; it should NOT appear in the body.
        expect("projectId" in body).toBe(false);
        expect(body.displayed_doc).toEqual({
            filename: "x.pdf",
            document_id: "d-1",
        });
    });
});

describe("mikeApi: chat history endpoints", () => {
    it("listChats GETs /chat; listProjectChats GETs /projects/:id/chats", async () => {
        const paths: string[] = [];
        server.use(
            http.get("*/api/chat", ({ request }) => {
                paths.push(new URL(request.url).pathname);
                return HttpResponse.json([]);
            }),
            http.get("*/api/projects/:id/chats", ({ request }) => {
                paths.push(new URL(request.url).pathname);
                return HttpResponse.json([]);
            }),
        );

        await listChats();
        await listProjectChats("p-1");

        expect(paths).toEqual(["/api/chat", "/api/projects/p-1/chats"]);
    });

    it("renameChat PATCHes /chat/:id with { title }", async () => {
        let body: unknown;
        server.use(
            http.patch("*/api/chat/:id", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ ok: true });
            }),
        );

        await renameChat("c-1", "New title");

        expect(body).toEqual({ title: "New title" });
    });

    it("deleteChat DELETEs /chat/:id", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/chat/:id", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );

        await deleteChat("c-1");

        expect(method).toBe("DELETE");
    });

    it("generateChatTitle POSTs /chat/:id/generate-title with { message }", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/chat/:id/generate-title", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ title: "Generated" });
            }),
        );

        const result = await generateChatTitle("c-1", "user said hi");

        expect(body).toEqual({ message: "user said hi" });
        expect(result).toEqual({ title: "Generated" });
    });
});

describe("mikeApi: getChat — server → client message mapping", () => {
    it("maps user messages with string content + files + workflow", async () => {
        server.use(
            http.get("*/api/chat/:id", () =>
                HttpResponse.json({
                    chat: { id: "c-1", title: "t" },
                    messages: [
                        {
                            id: "m1",
                            chat_id: "c-1",
                            role: "user",
                            content: "first question",
                            files: [{ filename: "f.pdf", document_id: "d-1" }],
                            workflow: { id: "wf-1", title: "Summarise" },
                            created_at: "2026-01-01",
                        },
                    ],
                }),
            ),
        );

        const { messages } = await getChat("c-1");

        expect(messages[0]).toEqual({
            role: "user",
            content: "first question",
            files: [{ filename: "f.pdf", document_id: "d-1" }],
            workflow: { id: "wf-1", title: "Summarise" },
        });
    });

    it("user message with null content becomes empty string", async () => {
        // Defensive: the server might emit null for a user message
        // with an upload-only turn.  Mapping to "" keeps the UI sane.
        server.use(
            http.get("*/api/chat/:id", () =>
                HttpResponse.json({
                    chat: { id: "c-1", title: "t" },
                    messages: [
                        {
                            id: "m1",
                            chat_id: "c-1",
                            role: "user",
                            content: null,
                            created_at: "2026-01-01",
                        },
                    ],
                }),
            ),
        );

        const { messages } = await getChat("c-1");
        expect(messages[0].content).toBe("");
    });

    it("assistant message: concatenates the text from every content event into `content`, preserves events", async () => {
        // This is THE seam that breaks under refactor: the server
        // emits the raw events array, the client recomputes the
        // plain-text `content` from just the content-type events,
        // and the UI relies on both being present.
        const events = [
            { type: "reasoning", text: "thinking" },
            { type: "content", text: "Hello, " },
            { type: "tool_call_start", name: "x" },
            { type: "content", text: "world." },
        ];
        server.use(
            http.get("*/api/chat/:id", () =>
                HttpResponse.json({
                    chat: { id: "c-1", title: "t" },
                    messages: [
                        {
                            id: "m2",
                            chat_id: "c-1",
                            role: "assistant",
                            content: events,
                            annotations: [],
                            created_at: "2026-01-01",
                        },
                    ],
                }),
            ),
        );

        const { messages } = await getChat("c-1");

        const m = messages[0];
        expect(m.role).toBe("assistant");
        expect(m.events).toEqual(events);
        // Plain content is just the joined text of `content`-type
        // events — reasoning + tool events are stripped.
        expect(m.content).toBe("Hello, world.");
    });

    it("assistant message with non-array content: content='' and events=undefined", async () => {
        // Defensive: a legacy row where `content` is a stringified
        // assistant reply (not an events array).  Map to empty
        // content + undefined events so the UI shows the message
        // but doesn't render a malformed events list.
        server.use(
            http.get("*/api/chat/:id", () =>
                HttpResponse.json({
                    chat: { id: "c-1", title: "t" },
                    messages: [
                        {
                            id: "m3",
                            chat_id: "c-1",
                            role: "assistant",
                            content: "legacy plain string",
                            created_at: "2026-01-01",
                        },
                    ],
                }),
            ),
        );

        const { messages } = await getChat("c-1");
        expect(messages[0]).toEqual({
            role: "assistant",
            content: "",
            annotations: undefined,
            events: undefined,
        });
    });
});

describe("mikeApi: query-string encoding", () => {
    it("listTabularReviews appends ?project_id when given", async () => {
        let search: string | null = null;
        server.use(
            http.get("*/api/tabular-review", ({ request }) => {
                search = new URL(request.url).search;
                return HttpResponse.json([]);
            }),
        );

        await listTabularReviews("p-1");

        expect(search).toBe("?project_id=p-1");
    });

    it("listTabularReviews omits the query string when projectId is absent", async () => {
        let search: string | null = null;
        server.use(
            http.get("*/api/tabular-review", ({ request }) => {
                search = new URL(request.url).search;
                return HttpResponse.json([]);
            }),
        );

        await listTabularReviews();

        expect(search).toBe("");
    });

    it("getDocumentUrl encodes the versionId", async () => {
        let search: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/url", ({ request }) => {
                search = new URL(request.url).search;
                return HttpResponse.json({
                    url: "u",
                    filename: "f",
                    version_id: "v with spaces",
                });
            }),
        );

        await getDocumentUrl("d-1", "v with spaces");

        expect(search).toBe("?version_id=v%20with%20spaces");
    });
});

describe("mikeApi: downloadDocumentsZip", () => {
    it("POSTs the document_ids array and returns a Blob", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/single-documents/download-zip", async ({ request }) => {
                body = await request.json();
                return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
                    headers: { "Content-Type": "application/zip" },
                });
            }),
        );

        const blob = await downloadDocumentsZip(["d-1", "d-2"]);

        expect(body).toEqual({ document_ids: ["d-1", "d-2"] });
        // Cross-realm Blob check — MSW v2 produces a Blob from a
        // different realm than the test scope, so `instanceof` is
        // unreliable in jsdom.  Duck-type on size + a read.
        expect(blob.size).toBe(4);
        expect(typeof blob.arrayBuffer).toBe("function");
        const buf = await blob.arrayBuffer();
        expect(new Uint8Array(buf)).toEqual(
            new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        );
    });

    it("throws on non-2xx with the response text", async () => {
        server.use(
            http.post("*/api/single-documents/download-zip", () =>
                HttpResponse.text("nope", { status: 500 }),
            ),
        );

        await expect(downloadDocumentsZip(["d"])).rejects.toThrow("nope");
    });
});

describe("mikeApi: mapTRMessages (pure helper)", () => {
    it("maps user messages with string content", () => {
        const result = mapTRMessages([
            {
                id: "m1",
                chat_id: "c",
                role: "user",
                content: "what does this contract say?",
                created_at: "2026-01-01",
            },
        ]);

        expect(result).toEqual([
            { role: "user", content: "what does this contract say?" },
        ]);
    });

    it("user message with non-string content collapses to empty string", () => {
        const result = mapTRMessages([
            {
                id: "m1",
                chat_id: "c",
                role: "user",
                content: null as unknown as string,
                created_at: "",
            },
        ]);
        expect(result[0]).toEqual({ role: "user", content: "" });
    });

    it("assistant message: joins content-type events, preserves events array, carries annotations", () => {
        const events = [
            { type: "reasoning" as const, text: "think" },
            { type: "content" as const, text: "A:" },
            { type: "content" as const, text: " 42." },
        ];
        const annotations = [
            {
                type: "tabular_citation" as const,
                ref: 1,
                col_index: 0,
                row_index: 0,
                col_name: "Answer",
                doc_name: "f.pdf",
                quote: "...",
            },
        ];

        const result = mapTRMessages([
            {
                id: "m2",
                chat_id: "c",
                role: "assistant",
                content: events,
                annotations,
                created_at: "",
            },
        ]);

        expect(result[0]).toEqual({
            role: "assistant",
            content: "A: 42.",
            events,
            annotations,
        });
    });

    it("assistant message with non-array content: content='', events=undefined, annotations defaulted to undefined", () => {
        const result = mapTRMessages([
            {
                id: "m3",
                chat_id: "c",
                role: "assistant",
                content: "some legacy string" as unknown as never,
                created_at: "",
            },
        ]);

        expect(result[0]).toEqual({
            role: "assistant",
            content: "",
            events: undefined,
            annotations: undefined,
        });
    });
});

// --- Smoke coverage for the remaining CRUD wrappers ------------------------
//
// Each function below delegates to `apiRequest` (or a manual fetch for
// the upload helpers) and is essentially a path + method + body shape.
// The wrapper contract is already pinned above; these tests verify the
// call-site each function makes so a typo in a path or a wrong verb
// fails loudly rather than silently breaking the page.

describe("mikeApi: smoke — project subresources", () => {
    it("getProject GETs /projects/:id", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/projects/:id", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({ id: "p-1", name: "n" });
            }),
        );
        await getProject("p-1");
        expect(path).toBe("/api/projects/p-1");
    });

    it("getProjectPeople GETs /projects/:id/people", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/projects/:id/people", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({
                    owner: { user_id: "u", email: null, display_name: null },
                    members: [],
                });
            }),
        );
        await getProjectPeople("p-1");
        expect(path).toBe("/api/projects/p-1/people");
    });

    it("addDocumentToProject POSTs /projects/:p/documents/:d (no body)", async () => {
        let method: string | null = null;
        let path: string | null = null;
        server.use(
            http.post("*/api/projects/:p/documents/:d", ({ request, params }) => {
                method = request.method;
                path = `/api/projects/${params.p}/documents/${params.d}`;
                return HttpResponse.json({ id: "d-1", filename: "x.pdf" });
            }),
        );
        await addDocumentToProject("p-1", "d-1");
        expect(method).toBe("POST");
        expect(path).toBe("/api/projects/p-1/documents/d-1");
    });
});

describe("mikeApi: smoke — folder CRUD", () => {
    it("createProjectFolder POSTs /projects/:id/folders with { name, parent_folder_id }", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/projects/:id/folders", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    id: "f-1",
                    name: "F",
                    project_id: "p",
                });
            }),
        );
        await createProjectFolder("p-1", "F", "parent-1");
        expect(body).toEqual({ name: "F", parent_folder_id: "parent-1" });
    });

    it("createProjectFolder defaults parent_folder_id to null when omitted", async () => {
        let body: Record<string, unknown> = {};
        server.use(
            http.post("*/api/projects/:id/folders", async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return HttpResponse.json({
                    id: "f-1",
                    name: "F",
                    project_id: "p",
                });
            }),
        );
        await createProjectFolder("p-1", "F");
        // Null (not undefined) — the backend expects a top-level
        // folder under the project root when the value is null.
        expect(body.parent_folder_id).toBeNull();
    });

    it("renameProjectFolder PATCHes with { name }", async () => {
        let body: unknown;
        server.use(
            http.patch("*/api/projects/:p/folders/:f", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    id: "f-1",
                    name: "Renamed",
                    project_id: "p",
                });
            }),
        );
        await renameProjectFolder("p-1", "f-1", "Renamed");
        expect(body).toEqual({ name: "Renamed" });
    });

    it("deleteProjectFolder DELETEs /projects/:p/folders/:f", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/projects/:p/folders/:f", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteProjectFolder("p-1", "f-1");
        expect(method).toBe("DELETE");
    });

    it("moveSubfolderToFolder PATCHes with { parent_folder_id }", async () => {
        let body: unknown;
        server.use(
            http.patch("*/api/projects/:p/folders/:f", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({
                    id: "f-1",
                    name: "n",
                    project_id: "p",
                });
            }),
        );
        await moveSubfolderToFolder("p", "f-1", "new-parent");
        expect(body).toEqual({ parent_folder_id: "new-parent" });
    });

    it("moveDocumentToFolder PATCHes /projects/:p/documents/:d/folder with { folder_id }", async () => {
        let path: string | null = null;
        let body: unknown;
        server.use(
            http.patch(
                "*/api/projects/:p/documents/:d/folder",
                async ({ request, params }) => {
                    path = `/api/projects/${params.p}/documents/${params.d}/folder`;
                    body = await request.json();
                    return HttpResponse.json({ id: "d", filename: "x.pdf" });
                },
            ),
        );
        await moveDocumentToFolder("p", "d", "f-1");
        expect(path).toBe("/api/projects/p/documents/d/folder");
        expect(body).toEqual({ folder_id: "f-1" });
    });
});

describe("mikeApi: smoke — single document versions", () => {
    it("listDocumentVersions GETs /single-documents/:id/versions", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/versions", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({
                    current_version_id: null,
                    versions: [],
                });
            }),
        );
        await listDocumentVersions("d-1");
        expect(path).toBe("/api/single-documents/d-1/versions");
    });

    // Dev's API took the field name "filename" (mirror-era: display_name).
    it("uploadDocumentVersion POSTs multipart with optional filename field", async () => {
        let hasFile = false;
        let displayNameField: string | null = null;
        server.use(
            http.post(
                "*/api/single-documents/:id/versions",
                async ({ request }) => {
                    const form = await request.formData();
                    hasFile = form.has("file");
                    const dn = form.get("filename");
                    if (typeof dn === "string") displayNameField = dn;
                    return HttpResponse.json({
                        id: "v",
                        version_number: 1,
                        source: "upload",
                        created_at: "2026-01-01",
                        display_name: "v1",
                    });
                },
            ),
        );

        await uploadDocumentVersion(
            "d-1",
            new File([""], "v.docx"),
            "v1",
        );

        expect(hasFile).toBe(true);
        expect(displayNameField).toBe("v1");
    });

    it("uploadDocumentVersion omits filename when undefined", async () => {
        let displayNamePresent = true;
        server.use(
            http.post(
                "*/api/single-documents/:id/versions",
                async ({ request }) => {
                    const form = await request.formData();
                    displayNamePresent = form.has("filename");
                    return HttpResponse.json({
                        id: "v",
                        version_number: 1,
                        source: "upload",
                        created_at: "",
                        display_name: null,
                    });
                },
            ),
        );
        await uploadDocumentVersion("d-1", new File([""], "v.docx"));
        expect(displayNamePresent).toBe(false);
    });

    it("renameDocumentVersion PATCHes /single-documents/:d/versions/:v with { filename }", async () => {
        let body: unknown;
        server.use(
            http.patch(
                "*/api/single-documents/:d/versions/:v",
                async ({ request }) => {
                    body = await request.json();
                    return HttpResponse.json({
                        id: "v",
                        version_number: 1,
                        source: "upload",
                        created_at: "",
                        display_name: "Renamed",
                    });
                },
            ),
        );
        await renameDocumentVersion("d-1", "v-1", "Renamed");
        expect(body).toEqual({ filename: "Renamed" });
    });

    it("listStandaloneDocuments GETs /single-documents", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/single-documents", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json([]);
            }),
        );
        await listStandaloneDocuments();
        expect(path).toBe("/api/single-documents");
    });

    it("deleteDocument DELETEs /single-documents/:id", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/single-documents/:id", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteDocument("d-1");
        expect(method).toBe("DELETE");
    });
});

describe("mikeApi: smoke — chat endpoints (remaining)", () => {
    it("createChat POSTs /chat/create with project_id (or {} when omitted)", async () => {
        const bodies: unknown[] = [];
        server.use(
            http.post("*/api/chat/create", async ({ request }) => {
                bodies.push(await request.json());
                return HttpResponse.json({ id: "c-new" });
            }),
        );

        await createChat({ project_id: "p-1" });
        await createChat();
        await createChat({});

        expect(bodies).toEqual([{ project_id: "p-1" }, {}, {}]);
    });
});

describe("mikeApi: smoke — tabular review CRUD", () => {
    it("createTabularReview POSTs /tabular-review with the payload", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/tabular-review", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ id: "r-1", title: "t" });
            }),
        );

        await createTabularReview({
            title: "Review",
            document_ids: ["d-1"],
            columns_config: [
                { index: 0, name: "Name", prompt: "What is the party name?" },
            ],
            workflow_id: "wf-1",
            project_id: "p-1",
        });

        expect(body).toEqual({
            title: "Review",
            document_ids: ["d-1"],
            columns_config: [
                { index: 0, name: "Name", prompt: "What is the party name?" },
            ],
            workflow_id: "wf-1",
            project_id: "p-1",
        });
    });

    it("getTabularReview GETs /tabular-review/:id", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/tabular-review/:id", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({});
            }),
        );
        await getTabularReview("r-1");
        expect(path).toBe("/api/tabular-review/r-1");
    });

    it("updateTabularReview PATCHes /tabular-review/:id", async () => {
        let method: string | null = null;
        let body: unknown;
        server.use(
            http.patch("*/api/tabular-review/:id", async ({ request }) => {
                method = request.method;
                body = await request.json();
                return HttpResponse.json({ id: "r-1", title: "New" });
            }),
        );
        await updateTabularReview("r-1", { title: "New" });
        expect(method).toBe("PATCH");
        expect(body).toEqual({ title: "New" });
    });

    it("getTabularReviewPeople GETs /tabular-review/:id/people", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/tabular-review/:id/people", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({
                    owner: { user_id: "u", email: null, display_name: null },
                    members: [],
                });
            }),
        );
        await getTabularReviewPeople("r-1");
        expect(path).toBe("/api/tabular-review/r-1/people");
    });

    it("generateTabularColumnPrompt POSTs /tabular-review/prompt with optional fields", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/tabular-review/prompt", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ prompt: "...", source: "llm" });
            }),
        );

        await generateTabularColumnPrompt("Effective Date", {
            format: "date",
            documentName: "Contract",
            tags: ["dates"],
        });

        expect(body).toEqual({
            title: "Effective Date",
            format: "date",
            documentName: "Contract",
            tags: ["dates"],
        });
    });

    it("deleteTabularReview DELETEs /tabular-review/:id", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/tabular-review/:id", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteTabularReview("r-1");
        expect(method).toBe("DELETE");
    });

    it("uploadReviewDocument: uploads standalone + PATCHes the review's document_ids", async () => {
        const calls: { kind: string; body?: unknown }[] = [];
        server.use(
            http.post("*/api/single-documents", async () => {
                calls.push({ kind: "upload" });
                return HttpResponse.json({ id: "d-new", filename: "f.pdf" });
            }),
            http.patch("*/api/tabular-review/:id", async ({ request }) => {
                calls.push({ kind: "patch", body: await request.json() });
                return HttpResponse.json({ id: "r-1", title: "t" });
            }),
        );

        await uploadReviewDocument("r-1", new File([""], "f.pdf"), {
            documentIds: ["d-existing"],
            columnsConfig: [
                { index: 0, name: "N", prompt: "p" },
            ],
        });

        expect(calls.map((c) => c.kind)).toEqual(["upload", "patch"]);
        // The PATCH body appends the new id to the existing list.
        expect(calls[1].body).toEqual({
            columns_config: [{ index: 0, name: "N", prompt: "p" }],
            document_ids: ["d-existing", "d-new"],
        });
    });

    it("uploadReviewDocument routes through uploadProjectDocument when projectId is given", async () => {
        const paths: string[] = [];
        server.use(
            http.post("*/api/projects/:p/documents", async ({ request }) => {
                paths.push(new URL(request.url).pathname);
                return HttpResponse.json({ id: "d-p", filename: "f.pdf" });
            }),
            http.patch("*/api/tabular-review/:id", () =>
                HttpResponse.json({ id: "r-1", title: "t" }),
            ),
        );

        await uploadReviewDocument("r-1", new File([""], "f.pdf"), {
            projectId: "p-99",
        });

        expect(paths).toEqual(["/api/projects/p-99/documents"]);
    });
});

describe("mikeApi: smoke — tabular review streaming + cells", () => {
    it("streamTabularGeneration POSTs /tabular-review/:id/generate (no body, no Content-Type)", async () => {
        let method: string | null = null;
        let contentType: string | null = null;
        server.use(
            http.post("*/api/tabular-review/:id/generate", ({ request }) => {
                method = request.method;
                contentType = request.headers.get("Content-Type");
                return new HttpResponse("data: [DONE]\n\n", {
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await streamTabularGeneration("r-1");
        expect(method).toBe("POST");
        // Manual fetch with no Content-Type override.
        expect(contentType).toBeNull();
    });

    it("streamTabularChat POSTs /tabular-review/:id/chat with messages + chat_id + context", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/tabular-review/:id/chat", async ({ request }) => {
                body = await request.json();
                return new HttpResponse("data: [DONE]\n\n", {
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await streamTabularChat(
            "r-1",
            [{ role: "user", content: "hi" }],
            "c-1",
            undefined,
            { reviewTitle: "Review", projectName: "Proj" },
        );
        expect(body).toEqual({
            messages: [{ role: "user", content: "hi" }],
            chat_id: "c-1",
            review_title: "Review",
            project_name: "Proj",
        });
    });

    it("streamTabularChat omits chat_id/context when not provided", async () => {
        let body: Record<string, unknown> = {};
        server.use(
            http.post("*/api/tabular-review/:id/chat", async ({ request }) => {
                body = (await request.json()) as Record<string, unknown>;
                return new HttpResponse("data: [DONE]\n\n", {
                    headers: { "Content-Type": "text/event-stream" },
                });
            }),
        );
        await streamTabularChat("r-1", [{ role: "user", content: "hi" }]);
        expect("chat_id" in body).toBe(false);
        expect("review_title" in body).toBe(false);
        expect("project_name" in body).toBe(false);
    });

    it("getTabularChats GETs /tabular-review/:id/chats", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/tabular-review/:id/chats", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json([]);
            }),
        );
        await getTabularChats("r-1");
        expect(path).toBe("/api/tabular-review/r-1/chats");
    });

    it("getTabularChatMessages GETs /tabular-review/:r/chats/:c/messages", async () => {
        let path: string | null = null;
        server.use(
            http.get(
                "*/api/tabular-review/:r/chats/:c/messages",
                ({ request }) => {
                    path = new URL(request.url).pathname;
                    return HttpResponse.json([]);
                },
            ),
        );
        await getTabularChatMessages("r-1", "c-1");
        expect(path).toBe("/api/tabular-review/r-1/chats/c-1/messages");
    });

    it("deleteTabularChat DELETEs /tabular-review/:r/chats/:c", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/tabular-review/:r/chats/:c", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteTabularChat("r-1", "c-1");
        expect(method).toBe("DELETE");
    });

    it("regenerateTabularCell POSTs with { document_id, column_index }", async () => {
        let body: unknown;
        server.use(
            http.post(
                "*/api/tabular-review/:id/regenerate-cell",
                async ({ request }) => {
                    body = await request.json();
                    return HttpResponse.json({
                        summary: "s",
                        flag: "green",
                        reasoning: "r",
                    });
                },
            ),
        );
        await regenerateTabularCell("r-1", "d-1", 3);
        expect(body).toEqual({ document_id: "d-1", column_index: 3 });
    });

    it("clearTabularCells POSTs with { document_ids }", async () => {
        let body: unknown;
        server.use(
            http.post(
                "*/api/tabular-review/:id/clear-cells",
                async ({ request }) => {
                    body = await request.json();
                    return HttpResponse.json({});
                },
            ),
        );
        await clearTabularCells("r-1", ["d-1", "d-2"]);
        expect(body).toEqual({ document_ids: ["d-1", "d-2"] });
    });
});

describe("mikeApi: smoke — workflows", () => {
    it("listWorkflows GETs /workflows?type=...", async () => {
        let search: string | null = null;
        server.use(
            http.get("*/api/workflows", ({ request }) => {
                search = new URL(request.url).search;
                return HttpResponse.json([]);
            }),
        );
        await listWorkflows("assistant");
        expect(search).toBe("?type=assistant");
    });

    it("getWorkflow GETs /workflows/:id", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/workflows/:id", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json({});
            }),
        );
        await getWorkflow("wf-1");
        expect(path).toBe("/api/workflows/wf-1");
    });

    it("createWorkflow POSTs the payload to /workflows", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/workflows", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ id: "wf-new" });
            }),
        );
        await createWorkflow({
            title: "Summary",
            type: "assistant",
            prompt_md: "# do the thing",
            practice: "Contracts",
        });
        expect(body).toEqual({
            title: "Summary",
            type: "assistant",
            prompt_md: "# do the thing",
            practice: "Contracts",
        });
    });

    it("updateWorkflow PATCHes /workflows/:id", async () => {
        let method: string | null = null;
        let body: unknown;
        server.use(
            http.patch("*/api/workflows/:id", async ({ request }) => {
                method = request.method;
                body = await request.json();
                return HttpResponse.json({});
            }),
        );
        await updateWorkflow("wf-1", { title: "New", practice: null });
        expect(method).toBe("PATCH");
        expect(body).toEqual({ title: "New", practice: null });
    });

    it("deleteWorkflow DELETEs /workflows/:id", async () => {
        let method: string | null = null;
        server.use(
            http.delete("*/api/workflows/:id", ({ request }) => {
                method = request.method;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteWorkflow("wf-1");
        expect(method).toBe("DELETE");
    });

    it("listHiddenWorkflows GETs /workflows/hidden", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/workflows/hidden", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json([]);
            }),
        );
        await listHiddenWorkflows();
        expect(path).toBe("/api/workflows/hidden");
    });

    it("hideWorkflow POSTs /workflows/hidden with { workflow_id }", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/workflows/hidden", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({});
            }),
        );
        await hideWorkflow("wf-1");
        expect(body).toEqual({ workflow_id: "wf-1" });
    });

    it("unhideWorkflow DELETEs /workflows/hidden/:id", async () => {
        let method: string | null = null;
        let path: string | null = null;
        server.use(
            http.delete("*/api/workflows/hidden/:id", ({ request }) => {
                method = request.method;
                path = new URL(request.url).pathname;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await unhideWorkflow("wf-1");
        expect(method).toBe("DELETE");
        expect(path).toBe("/api/workflows/hidden/wf-1");
    });

    it("shareWorkflow POSTs /workflows/:id/share with { emails, allow_edit }", async () => {
        let body: unknown;
        server.use(
            http.post("*/api/workflows/:id/share", async ({ request }) => {
                body = await request.json();
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await shareWorkflow("wf-1", {
            emails: ["alice@example.com"],
            allow_edit: true,
        });
        expect(body).toEqual({
            emails: ["alice@example.com"],
            allow_edit: true,
        });
    });

    it("listWorkflowShares GETs /workflows/:id/shares", async () => {
        let path: string | null = null;
        server.use(
            http.get("*/api/workflows/:id/shares", ({ request }) => {
                path = new URL(request.url).pathname;
                return HttpResponse.json([]);
            }),
        );
        await listWorkflowShares("wf-1");
        expect(path).toBe("/api/workflows/wf-1/shares");
    });

    it("deleteWorkflowShare DELETEs /workflows/:w/shares/:s", async () => {
        let path: string | null = null;
        server.use(
            http.delete("*/api/workflows/:w/shares/:s", ({ request }) => {
                path = new URL(request.url).pathname;
                return new HttpResponse(null, { status: 204 });
            }),
        );
        await deleteWorkflowShare("wf-1", "share-1");
        expect(path).toBe("/api/workflows/wf-1/shares/share-1");
    });
});
