import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  uploadTransport: vi.fn(() => "authenticated_parts"),
  stageUploadPart: vi.fn(),
  sealUploadParts: vi.fn(),
  headFile: vi.fn(),
  copyFile: vi.fn(),
}));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  ...storage,
}));

import { completeUploadSessionFile, putAuthenticatedUploadPart } from "../uploads.sessions";

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "entra|tenant|owner",
  status: "pending_upload",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};
const file = {
  id: "22222222-2222-4222-8222-222222222222",
  session_id: session.id,
  client_id: "client-1",
  filename: "a.pdf",
  status: "pending_upload",
  content_type: "application/pdf",
  expected_size_bytes: 4,
  staging_storage_path: "upload-sessions/u/s/f/staging",
  sealed_storage_path: "upload-sessions/u/s/f/sealed",
  upload_transport: "authenticated_parts",
  upload_generation: "33333333-3333-4333-8333-333333333333",
};
const partClaim = "44444444-4444-4444-8444-444444444444";
const verifyClaim = "55555555-5555-4555-8555-555555555555";

function dbForParts() {
  const row = { ...file };
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_upload_part") return { data: { status: "claimed", claim_token: partClaim }, error: null };
    if (name === "complete_upload_part" || name === "extend_upload_session_expiry")
      return { data: true, error: null };
    if (name === "claim_upload_verification") return { data: verifyClaim, error: null };
    if (name === "finish_upload_verification") { row.status = "uploaded"; return { data: true, error: null }; }
    if (name === "queue_upload_session_file_processing") return { data: "job-1", error: null };
    if (name === "refresh_upload_session_status") return { data: true, error: null };
    throw new Error(`unexpected RPC ${name}`);
  });
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: table === "upload_session_parts"
        ? [{ part_index: 0, claim_token: partClaim, size_bytes: 4 }] : [row], error: null }),
      maybeSingle: async () => ({ data: session, error: null }),
    };
    return query;
  });
  return { from, rpc };
}

describe("private Azure upload module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.uploadTransport.mockReturnValue("authenticated_parts");
    storage.stageUploadPart.mockImplementation(async (_key, _block, body: Readable) => {
      let bytes = 0;
      for await (const chunk of body) bytes += (chunk as Buffer).byteLength;
      expect(bytes).toBe(4);
    });
    storage.headFile.mockResolvedValue({ size: 4, contentType: "application/pdf", etag: "etag-1" });
    storage.sealUploadParts.mockResolvedValue(undefined);
    storage.copyFile.mockResolvedValue(undefined);
  });

  it("streams a bounded authenticated part into its generation's block and receipts it", async () => {
    const db = dbForParts();
    const result = await putAuthenticatedUploadPart(db as never, {
      sessionId: session.id, fileId: file.id, userId: session.user_id,
      generation: file.upload_generation, partIndex: 0, contentLength: 4,
      body: Readable.from([Buffer.from("test")]),
    });
    expect(result).toEqual({ ok: true, data: { status: "completed" } });
    expect(storage.stageUploadPart).toHaveBeenCalledWith(
      `${file.staging_storage_path}/generations/${file.upload_generation}`,
      Buffer.from(partClaim.replace(/-/g, ""), "hex").toString("base64"),
      expect.any(Readable), 4, expect.any(AbortSignal),
    );
    expect(db.rpc).toHaveBeenCalledWith("complete_upload_part", expect.objectContaining({
      p_generation: file.upload_generation, p_claim_token: partClaim,
    }));
  });

  it("seals current-generation receipts before copying an immutable verification candidate", async () => {
    const db = dbForParts();
    const result = await completeUploadSessionFile(db as never, {
      sessionId: session.id, fileId: file.id, userId: session.user_id, failed: false,
    });
    expect(result.ok).toBe(true);
    const path = `${file.staging_storage_path}/generations/${file.upload_generation}`;
    expect(storage.sealUploadParts).toHaveBeenCalledWith(path, [
      Buffer.from(partClaim.replace(/-/g, ""), "hex").toString("base64"),
    ], file.content_type);
    expect(storage.copyFile).toHaveBeenCalledWith(path,
      `${file.sealed_storage_path}/claims/${verifyClaim}`, "etag-1");
    expect(db.rpc).toHaveBeenCalledWith("finish_upload_verification", expect.objectContaining({
      p_claim_token: verifyClaim, p_status: "uploaded",
    }));
  });
});
