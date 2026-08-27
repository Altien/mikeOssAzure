import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../app";

const originalModules = process.env.MIKE_ENABLED_MODULES;

beforeEach(() => {
  process.env.MIKE_ENABLED_MODULES = "none";
});

afterEach(() => {
  if (originalModules === undefined) delete process.env.MIKE_ENABLED_MODULES;
  else process.env.MIKE_ENABLED_MODULES = originalModules;
});

describe("deployment module route gates", () => {
  it("returns a stable unavailable response before authentication", async () => {
    const response = await request(app).get("/prompts").expect(404);
    expect(response.body).toEqual({
      detail: "This optional module is not enabled for this Mike deployment.",
      code: "module_unavailable",
      module: "promptLibrary",
    });
  });

  it("continues to authentication when the module is available", async () => {
    process.env.MIKE_ENABLED_MODULES = "promptLibrary";
    await request(app).get("/prompts").expect(401);
  });

  it("also gates unauthenticated OAuth callbacks for disabled integrations", async () => {
    const response = await request(app)
      .get("/integrations/gmail/oauth/callback")
      .expect(404);
    expect(response.body).toMatchObject({
      code: "module_unavailable",
      module: "gmail",
    });
  });
});
