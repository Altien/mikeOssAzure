import { describe, expect, it, vi } from "vitest";

const { checkProjectAccess, getMemoryCurrent, listAccessibleProjectIds } =
  vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    getMemoryCurrent: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
  }));

vi.mock("../access", () => ({
  checkProjectAccess,
  listAccessibleProjectIds,
}));

vi.mock("./files", () => ({ getMemoryCurrent }));

import JSZip from "jszip";
import { buildMemoryArchive } from "./archive";

describe("buildMemoryArchive", () => {
  it("includes app and currently accessible project Markdown without unsafe paths", async () => {
    listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
    checkProjectAccess.mockImplementation(async (projectId: string) => ({
      ok: projectId === "p1",
    }));
    getMemoryCurrent.mockImplementation(
      async (_db: unknown, scope: string, ownerId: string) => ({
        current: {
          content:
            scope === "user" ? "# App memory" : `# Project ${ownerId}`,
        },
      }),
    );
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(async () => ({
            data: [
              { id: "p2", name: "Revoked" },
              { id: "p1", name: "../Matter/Alpha" },
            ],
            error: null,
          })),
        })),
      })),
    };

    const buffer = await buildMemoryArchive(
      db as never,
      "u1",
      "u1@example.test",
    );
    const zip = await JSZip.loadAsync(buffer);
    const fileNames = Object.keys(zip.files).filter(
      (name) => !zip.files[name].dir,
    );
    const projectFile = fileNames.find((name) => name.includes("--p1/"));

    expect(await zip.file("app/memory.md")?.async("string")).toBe(
      "# App memory",
    );
    expect(projectFile).toBeTruthy();
    expect(projectFile).not.toContain("..");
    expect(projectFile).not.toContain("\\");
    expect(await zip.file(projectFile!)?.async("string")).toBe("# Project p1");
    expect(fileNames.some((name) => name.includes("--p2/"))).toBe(false);
    expect(getMemoryCurrent).not.toHaveBeenCalledWith(
      db,
      "project",
      "p2",
      true,
    );
  });
});
