import { describe, expect, it } from "vitest";
import { projectWordDocumentEditEvents } from "../wordDocumentEdits";

describe("projectWordDocumentEditEvents", () => {
  it("keeps prose and edit references in exact source order", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "content",
        text: [
          "Opening prose.",
          "<EDITS>",
          JSON.stringify([
            {
              type: "edit_data",
              kind: "edit",
              deleted_text: "ten days",
              inserted_text: "five days",
              reason: "Shortens the cure period",
            },
            {
              type: "edit_data",
              kind: "edit",
              deleted_text: "written notice",
              formats: ["bold"],
              reason: "Highlights the requirement",
            },
          ]),
          "</EDITS>",
          "Closing prose.",
        ].join("\n"),
      },
    ]);

    expect(result.edits).toEqual([
      expect.objectContaining({
        blockIndex: 0,
        originalText: "ten days",
        replacementText: "five days",
      }),
      expect.objectContaining({
        blockIndex: 1,
        originalText: "written notice",
        formats: ["bold"],
      }),
    ]);
    expect(
      result.parts.map((part) =>
        part.kind === "content" ? part.text : `edit:${part.blockIndex}`,
      ),
    ).toEqual(["Opening prose.", "edit:0", "edit:1", "Closing prose."]);
  });

  it("leaves incomplete protocol in content instead of inventing an edit", () => {
    const source = 'Before\n<EDITS>\n[{"type":"edit_data"';
    const result = projectWordDocumentEditEvents([
      { type: "content", text: source },
    ]);

    expect(result.edits).toEqual([]);
    expect(result.parts).toEqual([
      expect.objectContaining({
        kind: "content",
        sourceEvent: { type: "content", text: source },
      }),
    ]);
  });

  it("preserves significant whitespace in JSON edit text", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "content",
        text: `<EDITS>${JSON.stringify([
          {
            type: "edit_data",
            kind: "edit",
            deleted_text: " target ",
            inserted_text: " replacement ",
            reason: "Preserves spacing",
          },
        ])}</EDITS>`,
      },
    ]);

    expect(result.edits[0]).toMatchObject({
      originalText: " target ",
      replacementText: " replacement ",
    });
  });
});
