import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  getUserModelSettingsMock,
  createServerSupabaseMock,
  getCourtlistenerCaseOpinionsMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  getUserModelSettingsMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  getCourtlistenerCaseOpinionsMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
// One mock for BOTH import specifiers: "../lib/userSettings" (this route)
// and "../lib/userSettings.js" (middleware/auth) resolve to the same
// module — two vi.mock calls would race and the first would win.
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
  getUserModelSettings: getUserModelSettingsMock,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/courtlistener", () => ({
  getCourtlistenerCaseOpinions: getCourtlistenerCaseOpinionsMock,
}));

import { makeApp } from "../test/helpers/buildTestApp";

beforeEach(() => {
  process.env.AUTH_PROVIDER = "supabase";
  process.env.NODE_ENV = "test";
  validateSupabaseTokenMock.mockReset();
  validateSupabaseTokenMock.mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      email: "u@x.com",
      groups: [],
      roles: [],
      provider: "supabase",
    },
  });
  upsertUserProfileMock.mockReset();
  upsertUserProfileMock.mockResolvedValue(undefined);
  getUserModelSettingsMock.mockReset();
  getUserModelSettingsMock.mockResolvedValue({
    api_keys: { courtlistener: "cl-token" },
  });
  createServerSupabaseMock.mockReset();
  createServerSupabaseMock.mockReturnValue({});
  getCourtlistenerCaseOpinionsMock.mockReset();
});

describe("POST /api/case-law/case-opinions", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp())
      .post("/api/case-law/case-opinions")
      .send({ clusterId: 42 });

    expect(res.status).toBe(401);
    expect(getCourtlistenerCaseOpinionsMock).not.toHaveBeenCalled();
  });

  it("400s without a usable cluster id (missing, non-numeric, non-positive)", async () => {
    for (const body of [{}, { clusterId: "abc" }, { clusterId: -5 }]) {
      const res = await request(makeApp())
        .post("/api/case-law/case-opinions")
        .set("Authorization", "Bearer ok")
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ detail: "cluster_id is required" });
    }
  });

  it("fetches opinions with the user's CourtListener token and returns them", async () => {
    getCourtlistenerCaseOpinionsMock.mockResolvedValueOnce({
      opinions: [{ id: 1, text: "..." }],
    });

    // snake_case cluster_id (string) is accepted alongside clusterId.
    const res = await request(makeApp())
      .post("/api/case-law/case-opinions")
      .set("Authorization", "Bearer ok")
      .send({ cluster_id: "42" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opinions: [{ id: 1, text: "..." }] });
    expect(getCourtlistenerCaseOpinionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterId: 42,
        includeFullText: true,
        apiToken: "cl-token",
      }),
    );
  });

  it("normalises a malformed fetch result to an empty opinions array", async () => {
    getCourtlistenerCaseOpinionsMock.mockResolvedValueOnce("not-an-object");

    const res = await request(makeApp())
      .post("/api/case-law/case-opinions")
      .set("Authorization", "Bearer ok")
      .send({ clusterId: 42 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opinions: [] });
  });

  it("maps upstream failures to 502 with the error message", async () => {
    getCourtlistenerCaseOpinionsMock.mockRejectedValueOnce(
      new Error("CourtListener 429: throttled"),
    );

    const res = await request(makeApp())
      .post("/api/case-law/case-opinions")
      .set("Authorization", "Bearer ok")
      .send({ clusterId: 42 });

    expect(res.status).toBe(502);
    expect(res.body.detail).toBe("CourtListener 429: throttled");
  });

  it("joins concurrent requests for the same user+cluster into ONE upstream fetch", async () => {
    let release!: (value: unknown) => void;
    getCourtlistenerCaseOpinionsMock.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    const app = makeApp();

    // Promise.resolve() assimilates the supertest thenable, which is what
    // actually starts the request — without it both requests would only
    // fire at the Promise.all below, i.e. after release().
    const [first, second] = [
      Promise.resolve(
        request(app)
          .post("/api/case-law/case-opinions")
          .set("Authorization", "Bearer ok")
          .send({ clusterId: 7 }),
      ),
      Promise.resolve(
        request(app)
          .post("/api/case-law/case-opinions")
          .set("Authorization", "Bearer ok")
          .send({ clusterId: 7 }),
      ),
    ];
    // Give both requests time to reach the in-flight map before resolving.
    await new Promise((r) => setTimeout(r, 50));
    release({ opinions: [{ id: 9 }] });

    const [res1, res2] = await Promise.all([first, second]);
    expect(res1.body).toEqual({ opinions: [{ id: 9 }] });
    expect(res2.body).toEqual({ opinions: [{ id: 9 }] });
    expect(getCourtlistenerCaseOpinionsMock).toHaveBeenCalledTimes(1);
  });
});
