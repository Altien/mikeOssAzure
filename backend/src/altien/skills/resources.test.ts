import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import { SkillResourceStore } from "./resources";

function store() {
  const fake = makeFakeDb((call) =>
    call.table === "document_versions"
      ? { data: [{ storage_path: `blob/${call.filters[0]?.[2]}` }], error: null }
      : { data: [], error: null },
  );
  return new SkillResourceStore(
    [
      {
        path: "references/guide.md",
        bytes: 100,
        media_type: "text/plain; charset=utf-8",
        inspection_class: "text",
        document_version_id: "guide-version",
        sha256: "guide-hash",
      },
      {
        path: "assets/demo.svg",
        bytes: 50,
        media_type: "image/svg+xml",
        inspection_class: "binary",
        document_version_id: "svg-version",
        sha256: "svg-hash",
      },
      {
        path: "nested.zip",
        bytes: 50,
        media_type: "application/octet-stream",
        inspection_class: "nested_archive",
        document_version_id: "zip-version",
        sha256: "zip-hash",
      },
    ],
    fake.db as never,
  );
}

describe("SkillResourceStore", () => {
  it("lists binary and nested resources as inert", () => {
    expect(store().list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "assets/demo.svg",
          readable: false,
          inert_reason: "binary",
        }),
        expect.objectContaining({
          path: "nested.zip",
          readable: false,
          inert_reason: "nested_archive",
        }),
      ]),
    );
  });

  it("uses exact manifest paths and bounded plain-text reads", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("0123456789 searchable text").buffer,
    );
    const resources = store();
    await expect(
      resources.read({
        path: "references/guide.md",
        offset: 2,
        max_chars: 5,
      }),
    ).resolves.toMatchObject({
      text: "23456",
      truncated: true,
      content_disposition: "plain_text_data",
    });
    await expect(
      resources.read({ path: "../references/guide.md" }),
    ).rejects.toThrow("not found");
    await expect(
      resources.read({ path: "assets/demo.svg" }),
    ).rejects.toThrow("inert");
  });

  it("searches only readable package resources", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("A searchable phrase.").buffer,
    );
    await expect(
      store().search({ query: "searchable", max_results: 5 }),
    ).resolves.toMatchObject({
      matches: [
        expect.objectContaining({ path: "references/guide.md", offset: 2 }),
      ],
    });
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
  });
});
