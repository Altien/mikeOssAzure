import { describe, expect, it } from "vitest";
import { planSkillRename } from "./adaptation";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("planSkillRename", () => {
  it("rewrites an adapted tree without mutating original bytes", () => {
    const originalSkill = bytes(
      "---\nname: Old Reader\ndescription: Reads\n---\nUse old-reader/references/guide.md with old-reader.",
    );
    const files = [
      {
        path: "old-reader/SKILL.md",
        bytes: originalSkill,
        inspectionClass: "text" as const,
      },
      {
        path: "old-reader/references/guide.md",
        bytes: bytes("Guide for old-reader."),
        inspectionClass: "text" as const,
      },
      {
        path: "old-reader/tool.bin",
        bytes: new Uint8Array([1, 2, 3]),
        inspectionClass: "binary" as const,
      },
    ];

    const plan = planSkillRename({
      files,
      entrypointPath: "old-reader/SKILL.md",
      oldDisplayName: "Old Reader",
      oldCanonicalName: "old-reader",
      newDisplayName: "New Reader",
    });

    expect(new TextDecoder().decode(originalSkill)).toContain("Old Reader");
    expect(plan.newCanonicalName).toBe("new-reader");
    expect(plan.newEntrypointPath).toBe("new-reader/SKILL.md");
    expect(plan.files.map((file) => file.path)).toEqual([
      "new-reader/SKILL.md",
      "new-reader/references/guide.md",
      "new-reader/tool.bin",
    ]);
    expect(new TextDecoder().decode(plan.files[0].bytes)).toContain(
      "name: New Reader",
    );
    expect(new TextDecoder().decode(plan.files[0].bytes)).toContain(
      "new-reader/references/guide.md",
    );
    expect(plan.changes).toHaveLength(3);
    expect(plan.treeHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
