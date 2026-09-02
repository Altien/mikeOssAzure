import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  validateSupabaseTokenMock,
  upsertUserProfileMock,
  getUserModelSettingsMock,
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  getUserModelSettingsMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
  getUserModelSettings: getUserModelSettingsMock,
}));

import { makeApp } from "../test/helpers/buildTestApp";

const AUTH = "Bearer token";
let helpDir: string;

// The route resolves its directory once, at module load, so each case gets a
// fresh temp directory and a freshly imported module. Testing against a
// fixture rather than the shipped guides keeps these cases true whatever
// docs/help happens to contain.
async function appWithGuides(
  files: Record<string, string>,
): Promise<ReturnType<typeof makeApp>> {
  helpDir = fs.mkdtempSync(path.join(os.tmpdir(), "help-test-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(helpDir, name), contents, "utf8");
  }
  process.env.HELP_DOCS_DIR = helpDir;
  vi.resetModules();
  const { makeApp: freshMakeApp } = await import(
    "../test/helpers/buildTestApp"
  );
  return freshMakeApp();
}

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
  getUserModelSettingsMock.mockResolvedValue({ api_keys: {} });
});

afterEach(() => {
  delete process.env.HELP_DOCS_DIR;
  if (helpDir && fs.existsSync(helpDir)) {
    fs.rmSync(helpDir, { recursive: true, force: true });
  }
});

describe("GET /api/help/articles", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).get("/api/help/articles");
    expect(res.status).toBe(401);
  });

  it("titles each guide from its first heading and sorts by title", async () => {
    const app = await appWithGuides({
      "zebra.md": "# Aardvarks\n\nBody.\n",
      "aardvark.md": "# Zebras\n\nBody.\n",
    });

    const res = await request(app)
      .get("/api/help/articles")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.articles).toEqual([
      { slug: "zebra", title: "Aardvarks" },
      { slug: "aardvark", title: "Zebras" },
    ]);
  });

  it("falls back to the slug when a guide has no heading", async () => {
    const app = await appWithGuides({ "untitled.md": "Body with no H1.\n" });

    const res = await request(app)
      .get("/api/help/articles")
      .set("Authorization", AUTH);

    expect(res.body.articles).toEqual([
      { slug: "untitled", title: "untitled" },
    ]);
  });

  it("does not list README.md or non-markdown files", async () => {
    const app = await appWithGuides({
      "README.md": "# Help guides\n\nContributor notes.\n",
      "notes.txt": "not markdown",
      "real-guide.md": "# A real guide\n",
    });

    const res = await request(app)
      .get("/api/help/articles")
      .set("Authorization", AUTH);

    expect(res.body.articles).toEqual([
      { slug: "real-guide", title: "A real guide" },
    ]);
  });

  it("returns an empty list when no guides are bundled", async () => {
    const app = await appWithGuides({});

    const res = await request(app)
      .get("/api/help/articles")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.articles).toEqual([]);
  });
});

describe("GET /api/help/articles/:slug", () => {
  it("returns the markdown for a bundled guide", async () => {
    const app = await appWithGuides({
      "a-guide.md": "# A guide\n\nSome content.\n",
    });

    const res = await request(app)
      .get("/api/help/articles/a-guide")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      slug: "a-guide",
      title: "A guide",
      markdown: "# A guide\n\nSome content.\n",
    });
  });

  it("404s for an unknown guide", async () => {
    const app = await appWithGuides({ "a-guide.md": "# A guide\n" });

    const res = await request(app)
      .get("/api/help/articles/does-not-exist")
      .set("Authorization", AUTH);

    expect(res.status).toBe(404);
  });

  // The route builds a filesystem path from a URL parameter, so traversal is
  // the risk that matters. Anything that is not a plain lowercase slug must be
  // refused before a path is constructed from it.
  it("refuses slugs that could escape the help directory", async () => {
    const app = await appWithGuides({ "a-guide.md": "# A guide\n" });
    const secret = path.join(helpDir, "..", "secret.md");
    fs.writeFileSync(secret, "# Not a guide\n", "utf8");

    try {
      const hostile = [
        "../secret",
        "..%2Fsecret",
        "..\\secret",
        "sub/dir",
        "A-Guide",
        "a_guide",
        ".env",
      ];

      for (const slug of hostile) {
        const res = await request(app)
          .get(`/api/help/articles/${encodeURIComponent(slug)}`)
          .set("Authorization", AUTH);

        expect(
          res.status,
          `expected ${JSON.stringify(slug)} to be refused, got ${res.status}`,
        ).not.toBe(200);
        expect(res.body.markdown).toBeUndefined();
      }
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});
