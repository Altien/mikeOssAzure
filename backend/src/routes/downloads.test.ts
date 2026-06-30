import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";

const {
  validateSupabaseTokenMock,
  validateLocalTokenMock,
  validateEntraTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  downloadFileMock,
  verifyDownloadMock,
  ensureDocAccessMock,
  buildContentDispositionMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  validateLocalTokenMock: vi.fn(),
  validateEntraTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  downloadFileMock: vi.fn(),
  verifyDownloadMock: vi.fn(),
  ensureDocAccessMock: vi.fn(),
  buildContentDispositionMock: vi.fn(
    (_disposition: string, name: string) => `attachment; filename="${name}"`,
  ),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/auth/providers/local.js", () => ({
  validateLocalToken: validateLocalTokenMock,
}));
vi.mock("../lib/auth/providers/entra.js", () => ({
  validateEntraToken: validateEntraTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/storage", () => ({
  downloadFile: downloadFileMock,
  buildContentDisposition: buildContentDispositionMock,
}));
vi.mock("../lib/downloadTokens", () => ({
  verifyDownload: verifyDownloadMock,
}));
vi.mock("../lib/access", () => ({
  ensureDocAccess: ensureDocAccessMock,
}));

import { makeApp } from "../test/helpers/buildTestApp";

const TOUCHED_ENV = ["AUTH_PROVIDER", "NODE_ENV"] as const;
const envSnapshot = {} as Record<string, string | undefined>;

const callerPrincipal = {
  userId: "user-1",
  email: "caller@example.com",
  groups: [],
  roles: [],
  provider: "supabase",
};

beforeEach(() => {
  for (const k of TOUCHED_ENV) envSnapshot[k] = process.env[k];
  process.env.AUTH_PROVIDER = "supabase";
  process.env.NODE_ENV = "test";

  validateSupabaseTokenMock.mockReset();
  validateLocalTokenMock.mockReset();
  validateEntraTokenMock.mockReset();
  upsertUserProfileMock.mockReset();
  upsertUserProfileMock.mockResolvedValue(undefined);
  createServerSupabaseMock.mockReset();
  downloadFileMock.mockReset();
  verifyDownloadMock.mockReset();
  ensureDocAccessMock.mockReset();
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

/** Build a fake supabase client with one queued result per call to from(). */
function fakeDbWithVersionAndDoc(
  version: { id: string; document_id: string } | null,
  doc: { id: string; user_id: string; project_id: string | null } | null,
) {
  let call = 0;
  return {
    from: vi.fn(() => {
      call += 1;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.is = () => builder;
      // First .from() call uses .maybeSingle() (lookup by storage_path);
      // second uses .single() (lookup by document_id).
      builder.maybeSingle = () => Promise.resolve({ data: version });
      builder.single = () => Promise.resolve({ data: doc });
      return builder;
    }),
  };
}

describe("GET /api/download/:token — wiring + auth gate", () => {
  it("requires authentication — 401 without an Authorization header", async () => {
    const res = await request(makeApp()).get("/api/download/abc.def");

    expect(res.status).toBe(401);
    expect(validateSupabaseTokenMock).not.toHaveBeenCalled();
    expect(verifyDownloadMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid token from the auth provider with the provider's status", async () => {
    validateSupabaseTokenMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      detail: "Token expired",
    });

    const res = await request(makeApp())
      .get("/api/download/abc.def")
      .set("Authorization", "Bearer bad-token");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "Token expired" });
    expect(verifyDownloadMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/download/:token — token verification", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
  });

  it("returns 404 'Invalid link' when verifyDownload rejects the token", async () => {
    verifyDownloadMock.mockReturnValueOnce(null);

    const res = await request(makeApp())
      .get("/api/download/forged.token")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "Invalid link" });
    // Must NOT proceed to the DB or the storage layer.
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
    expect(downloadFileMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/download/:token — DB lookups", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
  });

  it("returns 404 'File not found' when the storage_path resolves no version row", async () => {
    createServerSupabaseMock.mockReturnValue(
      fakeDbWithVersionAndDoc(null, null),
    );

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "File not found" });
    expect(downloadFileMock).not.toHaveBeenCalled();
  });

  it("returns 404 'File not found' when the version exists but the document row is missing", async () => {
    createServerSupabaseMock.mockReturnValue(
      fakeDbWithVersionAndDoc(
        { id: "ver-1", document_id: "doc-1" },
        null,
      ),
    );

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "File not found" });
    expect(ensureDocAccessMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/download/:token — access control", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
  });

  it("returns 404 (not 403) when the caller has no access — refuses to leak file existence", async () => {
    createServerSupabaseMock.mockReturnValue(
      fakeDbWithVersionAndDoc(
        { id: "ver-1", document_id: "doc-1" },
        { id: "doc-1", user_id: "different-owner", project_id: null },
      ),
    );
    ensureDocAccessMock.mockResolvedValueOnce({ ok: false });

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "File not found" });
    expect(downloadFileMock).not.toHaveBeenCalled();
  });

  it("calls ensureDocAccess with the loaded doc, the principal id, and the principal email", async () => {
    const doc = { id: "doc-1", user_id: "owner", project_id: "proj-1" };
    createServerSupabaseMock.mockReturnValue(
      fakeDbWithVersionAndDoc({ id: "ver-1", document_id: "doc-1" }, doc),
    );
    ensureDocAccessMock.mockResolvedValueOnce({ ok: true, isOwner: false });
    downloadFileMock.mockResolvedValueOnce(new ArrayBuffer(0));

    await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(ensureDocAccessMock).toHaveBeenCalledWith(
      doc,
      "user-1",
      "caller@example.com",
      expect.anything(),
    );
  });
});

describe("GET /api/download/:token — successful download", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
    createServerSupabaseMock.mockReturnValue(
      fakeDbWithVersionAndDoc(
        { id: "ver-1", document_id: "doc-1" },
        { id: "doc-1", user_id: "user-1", project_id: null },
      ),
    );
    ensureDocAccessMock.mockResolvedValue({ ok: true, isOwner: true });
  });

  it("returns 404 when the storage layer resolves but yields no bytes (deleted/expired blob)", async () => {
    verifyDownloadMock.mockReturnValueOnce({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
    downloadFileMock.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "File not found" });
  });

  it("streams the PDF bytes with the right Content-Type and attachment Content-Disposition", async () => {
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/doc.pdf",
      filename: "Report.pdf",
    });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    downloadFileMock.mockResolvedValueOnce(bytes.buffer);

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok")
      .responseType("arraybuffer");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="Report.pdf"',
    );
    expect(Buffer.from(res.body).equals(Buffer.from(bytes))).toBe(true);
  });

  it("uses the .docx mime type for .docx filenames", async () => {
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/doc.docx",
      filename: "Report.docx",
    });
    downloadFileMock.mockResolvedValueOnce(new ArrayBuffer(4));

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("uses the .xlsx mime type for .xlsx filenames", async () => {
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/sheet.xlsx",
      filename: "Sheet.xlsx",
    });
    downloadFileMock.mockResolvedValueOnce(new ArrayBuffer(4));

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/blob.bin",
      filename: "blob.bin",
    });
    downloadFileMock.mockResolvedValueOnce(new ArrayBuffer(4));

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  it("matches mime by suffix case-insensitively (PDF / .Pdf / .pdf all map the same)", async () => {
    verifyDownloadMock.mockReturnValue({
      path: "tenant-1/doc.PDF",
      filename: "Report.PDF",
    });
    downloadFileMock.mockResolvedValueOnce(new ArrayBuffer(4));

    const res = await request(makeApp())
      .get("/api/download/ok.token")
      .set("Authorization", "Bearer ok");

    expect(res.headers["content-type"]).toBe("application/pdf");
  });
});
