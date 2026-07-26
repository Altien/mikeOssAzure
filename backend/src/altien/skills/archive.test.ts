import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  SKILL_IMPORT_LIMITS,
  SkillArchiveValidationError,
  validateSkillZip,
} from "./archive";

async function zipOf(files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

const skill = (name: string, description = "A test skill") =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 1.2.3\n---\n\nFollow these instructions.`;

describe("validateSkillZip", () => {
  it("preserves a multi-skill tree and discovers entrypoints and licences", async () => {
    const input = await zipOf({
      "one/SKILL.md": skill("one"),
      "one/references/guide.md": "# Guide",
      "one/LICENSE": "MIT",
      "two/SKILL.md": skill("two", ">-\n  Review the document"),
      "shared/data.json": '{"ok":true}',
    });

    const result = await validateSkillZip(input);

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "one/LICENSE",
      "one/references/guide.md",
      "one/SKILL.md",
      "shared/data.json",
      "two/SKILL.md",
    ]);
    expect(result.skills).toMatchObject([
      {
        entrypointPath: "one/SKILL.md",
        rootPath: "one",
        declaredName: "one",
        declaredVersion: "1.2.3",
        licencePaths: ["one/LICENSE"],
      },
      {
        entrypointPath: "two/SKILL.md",
        declaredName: "two",
        description: "Review the document",
      },
    ]);
    expect(result.treeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same tree hash for the same files regardless of ZIP order", async () => {
    const first = await validateSkillZip(
      await zipOf({ "SKILL.md": skill("same"), "refs/a.md": "A" }),
    );
    const second = await validateSkillZip(
      await zipOf({ "refs/a.md": "A", "SKILL.md": skill("same") }),
    );
    expect(first.treeHash).toBe(second.treeHash);
  });

  it.each([
    ["missing frontmatter", { "SKILL.md": "Do the thing" }, "invalid_frontmatter"],
    [
      "missing description",
      { "SKILL.md": "---\nname: bad\n---\nBody" },
      "invalid_skill_description",
    ],
    ["no entrypoint", { "README.md": "Hello" }, "skill_missing"],
    [
      "case-colliding paths",
      { "SKILL.md": skill("x"), "Readme.md": "a", "README.md": "b" },
      "path_collision",
    ],
    [
      "private key",
      {
        "SKILL.md": skill("x"),
        "key.pem": "-----BEGIN PRIVATE KEY-----\nabc",
      },
      "credential_detected",
    ],
  ])("rejects %s", async (_label, files, code) => {
    await expect(validateSkillZip(await zipOf(files))).rejects.toMatchObject({
      code,
    });
  });

  it("rejects traversal using the original unsafe ZIP path", async () => {
    const input = await zipOf({
      "SKILL.md": skill("x"),
      "../escape.txt": "escape",
    });
    await expect(validateSkillZip(input)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects an oversized SKILL.md separately from the general file limit", async () => {
    const oversized =
      "---\nname: large\ndescription: large\n---\n" +
      "x".repeat(SKILL_IMPORT_LIMITS.skillMarkdownBytes);
    await expect(
      validateSkillZip(await zipOf({ "SKILL.md": oversized })),
    ).rejects.toMatchObject({ code: "skill_markdown_size_limit" });
  });

  it("rejects compressed input over the source limit before parsing", async () => {
    await expect(
      validateSkillZip(
        new Uint8Array(SKILL_IMPORT_LIMITS.compressedBytes + 1),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SkillArchiveValidationError>>({
        code: "compressed_size_limit",
      }),
    );
  });

  it("allows obvious placeholder credentials", async () => {
    const result = await validateSkillZip(
      await zipOf({
        "SKILL.md": skill("placeholders"),
        ".env.example": "API_KEY=your_api_key",
      }),
    );
    expect(result.skills[0].declaredName).toBe("placeholders");
  });
});
