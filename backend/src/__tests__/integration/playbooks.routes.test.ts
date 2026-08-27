import crypto from "node:crypto";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../app";
import { createServerSQLite } from "../../lib/sqlite";
import { deleteFile, listFiles } from "../../lib/storage";

let token = "";
let userId = "";
const originalProviderKeys = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  KIMI_API_KEY: process.env.KIMI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

function useOnlyKimiKey() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.KIMI_API_KEY = "test-kimi-key";
}

function restoreProviderKeys() {
  for (const [key, value] of Object.entries(originalProviderKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Liability must be capped at fees paid in the preceding twelve months.</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function compiledPlaybookJson() {
  return JSON.stringify({
    name: "Liability Playbook",
    description: "Standard liability position",
    globalGuidance: "Protect the customer.",
    representedParty: "Customer",
    documentTypes: ["MSA"],
    jurisdictions: [],
    topics: [{
      id: "liability",
      name: "Liability",
      rules: [{
        id: "liability-cap",
        name: "Liability cap",
        concept: "Determine whether liability is capped.",
        scope: "clause",
        required: true,
        guidance: "Escalate uncapped liability.",
        standard: null,
        fallbacks: [],
        unacceptable: [],
        conditions: [],
        actions: [],
        sourceRefs: ["P1"],
      }],
    }],
  });
}

beforeAll(async () => {
  const response = await request(app).post("/user/auth/signup").send({
    email: `playbooks-${crypto.randomUUID()}@test.local`,
    password: "test-password",
  });
  expect(response.status).toBe(200);
  token = response.body.token;
  userId = response.body.user.id;
});

afterAll(async () => {
  if (!userId) return;
  const db = createServerSQLite();
  const { data: playbooks } = await db.from("playbooks").select("source_storage_key").eq("user_id", userId);
  for (const playbook of playbooks ?? []) {
    if (playbook.source_storage_key) await deleteFile(String(playbook.source_storage_key));
  }
  await db.from("playbook_imports").delete().eq("user_id", userId);
  await db.from("playbook_runs").delete().eq("user_id", userId);
  await db.from("playbook_versions").delete().eq("user_id", userId);
  await db.from("playbooks").delete().eq("user_id", userId);
  await db.from("user_profiles").delete().eq("user_id", userId);
  await db.auth.admin.deleteUser(userId);
});

afterEach(() => {
  restoreProviderKeys();
  vi.restoreAllMocks();
});

describe("playbooks routes", () => {
  it("requires authentication", async () => {
    await request(app).get("/playbooks").expect(401);
  });

  it("lists playbooks and model configuration for an authenticated user", async () => {
    useOnlyKimiKey();
    const auth = { Authorization: `Bearer ${token}` };
    const list = await request(app).get("/playbooks").set(auth).expect(200);
    expect(list.body).toEqual([]);
    const configuration = await request(app).get("/playbooks/configuration").set(auth).expect(200);
    expect(configuration.body).toHaveProperty("configuredModels");
    expect(configuration.body.availableModelIds).toEqual(expect.arrayContaining(["kimi-k3", "kimi-k3-256k"]));
    expect(configuration.body.availableModelIds).not.toContain("gemini-3-flash-preview");
    expect(configuration.body.defaultModel).toBe("kimi-k3");
  });

  it("validates Word import files before model execution", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).post("/playbooks/import").set(auth).field("model", "gemini-3-flash-preview").expect(400);
    const response = await request(app)
      .post("/playbooks/import")
      .set(auth)
      .field("model", "gemini-3-flash-preview")
      .attach("file", Buffer.from("not a Word file"), "playbook.txt");
    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/\.docx/i);
  });

  it("preflights model credentials and records the failed stage", async () => {
    useOnlyKimiKey();
    const fetchMock = vi.spyOn(global, "fetch");
    const response = await request(app)
      .post("/playbooks/import")
      .set({ Authorization: `Bearer ${token}` })
      .field("model", "gemini-3-flash-preview")
      .attach("file", await sampleDocx(), "liability.docx");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "PLAYBOOK_IMPORT_FAILED",
      stage: "checking_model",
      importAttemptId: expect.any(String),
    });
    expect(response.body.detail).toMatch(/Gemini.*API key/i);
    expect(fetchMock).not.toHaveBeenCalled();

    const db = createServerSQLite();
    const { data: attempt } = await db.from("playbook_imports").select("*").eq("id", response.body.importAttemptId).maybeSingle();
    expect(attempt).toMatchObject({ status: "failed", stage: "checking_model", model: "gemini-3-flash-preview" });
  });

  it("records model compilation failures without storing a playbook", async () => {
    useOnlyKimiKey();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: "compiler offline" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ));
    const response = await request(app)
      .post("/playbooks/import")
      .set({ Authorization: `Bearer ${token}` })
      .field("model", "kimi-k3")
      .attach("file", await sampleDocx(), "failed.docx");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ stage: "compiling", importAttemptId: expect.any(String) });
    const db = createServerSQLite();
    const { data: attempt } = await db.from("playbook_imports").select("*").eq("id", response.body.importAttemptId).maybeSingle();
    expect(attempt).toMatchObject({ status: "failed", stage: "compiling", playbook_id: null });
    const { data: playbooks } = await db.from("playbooks").select("id").eq("user_id", userId);
    expect(playbooks).toEqual([]);
    expect(await listFiles(`playbooks/${userId}/`)).toEqual([]);
  });

  it("imports a real DOCX through extraction, compilation, storage, and persistence", async () => {
    useOnlyKimiKey();
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ choices: [{ message: { content: compiledPlaybookJson() }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const response = await request(app)
      .post("/playbooks/import")
      .set({ Authorization: `Bearer ${token}` })
      .field("model", "kimi-k3")
      .field("name", "Liability Playbook")
      .attach("file", await sampleDocx(), "liability.docx");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: "Liability Playbook",
      status: "draft",
      sourceFilename: "liability.docx",
      importModel: "kimi-k3",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const db = createServerSQLite();
    const { data: attempt } = await db.from("playbook_imports").select("*").eq("playbook_id", response.body.id).maybeSingle();
    expect(attempt).toMatchObject({ status: "completed", stage: "completed" });
    expect(await listFiles(`playbooks/${userId}/${response.body.id}/`)).toEqual([
      `playbooks/${userId}/${response.body.id}/source.docx`,
    ]);

    await request(app)
      .delete(`/playbooks/${response.body.id}`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(204);
    expect(await listFiles(`playbooks/${userId}/${response.body.id}/`)).toEqual([]);
  });
});
