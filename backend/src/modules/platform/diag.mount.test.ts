// /diag is the passphrase-protected health page (createDiagRouter); the OSS
// operator setup diagnostic lives at /diag/setup. Both used to be mounted at
// /diag, where the health page shadowed the setup page's GET /.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app";

describe("OSS operator diagnostic mount", () => {
  it("serves the setup page and its data under /diag/setup", async () => {
    const app = buildApp();
    const page = await request(app).get("/diag/setup");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>Mike auth diagnostic</title>");
    expect(page.text).toContain('fetch("/diag/setup/data"');
    const data = await request(app).get("/diag/setup/data");
    expect(data.status).toBe(200);
    expect(data.type).toMatch(/json/);
  });
});
