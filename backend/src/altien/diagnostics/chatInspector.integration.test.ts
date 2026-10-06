import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  checkProjectAccessMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  checkProjectAccessMock: vi.fn(),
}));

vi.mock("../../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
// Dev drift: requireAuth now takes upsertUserProfile from lib/userLookup
vi.mock("../../lib/userLookup.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../../lib/access", () => ({
  checkProjectAccess: checkProjectAccessMock,
}));

// Dev drift: upstream #295 moved routes/diagnostics into modules/platform
import { diagnosticsRouter } from "../../modules/platform/diagnostics.routes";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/diagnostics", diagnosticsRouter);
  return app;
}

beforeEach(() => {
  process.env.AUTH_PROVIDER = "supabase";
  validateSupabaseTokenMock.mockReset().mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      email: "user@example.com",
      groups: [],
      roles: [],
      provider: "supabase",
    },
  });
  upsertUserProfileMock.mockReset().mockResolvedValue(undefined);
  createServerSupabaseMock.mockReset();
  checkProjectAccessMock.mockReset();
});

describe("diagnostic chat API", () => {
  it("requires normal application authentication", async () => {
    const response = await request(makeApp()).get(
      "/api/admin/diagnostics/chats",
    );

    expect(response.status).toBe(401);
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
  });

  it("lists only the signed-in user's chats with a bounded limit", async () => {
    // Dev drift: requireAuth now reads the account_erasure_requests tombstone
    // (410 when a row exists) through the same client before the route runs.
    const { db, calls } = makeFakeDb((call) => call.table === "account_erasure_requests" ? { data: null } : ({
      data: [
        {
          id: "chat-1",
          title: "Authority review",
          user_id: "user-1",
          project_id: "project-1",
          created_at: "2026-07-25T12:00:00.000Z",
        },
      ],
    }));
    createServerSupabaseMock.mockReturnValue(db);

    const response = await request(makeApp())
      .get("/api/admin/diagnostics/chats?limit=9999")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.chats).toHaveLength(1);
    expect(calls.find((call) => call.table === "chats")).toMatchObject({
      table: "chats",
      columns: "id, title, user_id, project_id, created_at",
      filters: [
        ["eq", "user_id", "user-1"],
        ["range", "0", 99],
      ],
    });
  });

  it("returns a sanitized chronological trace and matching run reports", async () => {
    const respond = (call: DbCall) => {
      if (call.table === "chats") {
        return {
          data: [
            {
              id: "chat-1",
              title: "Authority review",
              user_id: "user-1",
              project_id: "project-1",
              created_at: "2026-07-25T12:00:00.000Z",
            },
          ],
        };
      }
      if (call.table === "chat_messages") {
        return {
          data: [
            {
              id: "message-1",
              role: "assistant",
              created_at: "2026-07-25T12:01:00.000Z",
              content: [
                { type: "content", text: "Verification complete." },
                {
                  type: "reasoning",
                  text: "private reasoning must not be returned",
                },
                {
                  type: "courtlistener_read_case",
                  cluster_id: 123,
                  case_name: "Example v Example",
                  opinion_count: 1,
                  secret_token: "must-not-leak",
                },
                {
                  type: "case_opinions",
                  case: { html: "full opinion body must not leak" },
                },
                {
                  type: "authority_trace_verification",
                  run_id: "run-1",
                  outcome: "success",
                  total: 1,
                  anchored: 1,
                  failed: 0,
                },
              ],
              annotations: [
                {
                  ref: 1,
                  kind: "case",
                  cluster_id: 123,
                  quote: "source passage must not leak",
                },
              ],
            },
          ],
        };
      }
      if (call.table === "citation_verification_runs") {
        return {
          data: [
            {
              id: "run-1",
              project_id: "project-1",
              report: {
                outcome: "success",
                total: 1,
                anchored: 1,
                failed: 0,
              },
              created_at: "2026-07-25T12:01:01.000Z",
            },
            {
              id: "run-other-project",
              project_id: "project-2",
              report: { outcome: "success" },
              created_at: "2026-07-25T12:01:01.000Z",
            },
          ],
        };
      }
      return { data: [] };
    };
    const { db } = makeFakeDb(respond);
    createServerSupabaseMock.mockReturnValue(db);

    const response = await request(makeApp())
      .get("/api/admin/diagnostics/chats/chat-1/trace")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.timeline.map((event: { type: string }) => event.type))
      .toEqual([
        "courtlistener_read_case",
        "authority_trace_verification",
      ]);
    expect(response.body.authority_trace_runs).toHaveLength(1);
    expect(response.body.authority_trace_runs[0].id).toBe("run-1");
    expect(response.body.messages[0].content[1]).toEqual({
      type: "reasoning",
      characters: 38,
    });
    expect(response.body.messages[0].annotations).toEqual([
      { ref: 1, kind: "case", cluster_id: 123 },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /must-not-leak|private reasoning|full opinion body|source passage/i,
    );
  });

  it("returns 404 without reading messages for an inaccessible chat", async () => {
    const { db, callsFor } = makeFakeDb((call) =>
      call.table === "chats"
        ? {
            data: [
              {
                id: "chat-2",
                title: "Other user",
                user_id: "user-2",
                project_id: "project-2",
                created_at: "2026-07-25T12:00:00.000Z",
              },
            ],
          }
        : { data: [] },
    );
    createServerSupabaseMock.mockReturnValue(db);
    checkProjectAccessMock.mockResolvedValue({ ok: false });

    const response = await request(makeApp())
      .get("/api/admin/diagnostics/chats/chat-2/trace")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Chat not found" });
    expect(callsFor("chat_messages")).toHaveLength(0);
  });
});
