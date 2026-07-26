import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
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

/**
 * JSZip cannot author encrypted archives, so flip general purpose bit flag 0 on
 * every local file header (offset 6) and central directory record (offset 8) of
 * a real archive to produce an encrypted-looking fixture.
 */
function withEncryptionFlag(input: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(input);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    const flagOffset =
      signature === 0x04034b50
        ? offset + 6
        : signature === 0x02014b50
          ? offset + 8
          : -1;
    if (flagOffset < 0 || flagOffset + 2 > bytes.byteLength) continue;
    view.setUint16(flagOffset, view.getUint16(flagOffset, true) | 0x0001, true);
  }
  return bytes;
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

  it("rejects an encrypted archive with a structured code", async () => {
    const input = withEncryptionFlag(await zipOf({ "SKILL.md": skill("x") }));
    await expect(validateSkillZip(input)).rejects.toEqual(
      expect.objectContaining<Partial<SkillArchiveValidationError>>({
        code: "encrypted_archive",
        message: "Encrypted ZIP archives are not supported.",
      }),
    );
  });

  it("aborts decompression as soon as an expansion limit is exceeded", async () => {
    const bomb = new JSZip();
    bomb.file("SKILL.md", skill("bomb"));
    bomb.file("payload.bin", new Uint8Array(64 * 1024 * 1024));
    const input = await bomb.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(input.byteLength).toBeLessThan(SKILL_IMPORT_LIMITS.compressedBytes);

    // Count every inflated chunk handed to the validator so the assertion below
    // proves the stream was aborted rather than fully expanded in memory.
    const probe = await JSZip.loadAsync(input);
    const zipObjectPrototype = Object.getPrototypeOf(probe.files["payload.bin"]);
    const originalInternalStream = zipObjectPrototype.internalStream;
    let inflatedBytes = 0;
    const spy = vi
      .spyOn(zipObjectPrototype, "internalStream")
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        const stream = originalInternalStream.apply(this, args);
        return stream.on("data", (chunk: Uint8Array) => {
          inflatedBytes += chunk.byteLength;
        });
      });

    try {
      await expect(validateSkillZip(input)).rejects.toMatchObject({
        code: "file_size_limit",
      });
    } finally {
      spy.mockRestore();
    }

    // Pausing stops JSZip feeding further compressed blocks, but the block
    // already inside pako finishes inflating: the ceiling is one 16 KB block at
    // DEFLATE's maximum 1032:1 ratio (~17 MB), independent of how large the
    // entry claims to be. Without the streaming abort the whole 64 MB payload
    // would be materialised before any limit was consulted.
    expect(inflatedBytes).toBeLessThan(24 * 1024 * 1024);
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
