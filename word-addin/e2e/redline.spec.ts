import { expect, test } from "@playwright/test";
import { projectRedlineStream } from "../src/taskpane/lib/redline";

function edit(
  deletedText: string,
  insertedText: string,
  reason = "Reason.",
): Record<string, unknown> {
  return {
    type: "edit_data",
    kind: "edit",
    deleted_text: deletedText,
    inserted_text: insertedText,
    reason,
  };
}

test.describe("streaming JSON edit projection", () => {
  test("waits for an array delimiter before sealing an edit", () => {
    const object = JSON.stringify(
      edit(" target ", " replacement ", "Preserves spacing"),
    );

    expect(projectRedlineStream(`<EDITS>[${object}`).safeEdits).toEqual([]);
    expect(projectRedlineStream(`<EDITS>[${object},`).safeEdits).toEqual([
      {
        original: " target ",
        replacement: " replacement ",
        reason: "Preserves spacing",
      },
    ]);
  });

  test("hides the protocol from its first partial chunk", () => {
    const projection = projectRedlineStream("Summary before edit.\n\n<EDI");

    expect(projection.visibleProse).toBe("Summary before edit.");
    expect(projection.protocolStarted).toBe(true);
    expect(projection.edits).toEqual([]);
    expect(projection.safeEdits).toEqual([]);
  });

  test("keeps an incomplete object hidden and unsafe", () => {
    const projection = projectRedlineStream(
      '<EDITS>[{"type":"edit_data","kind":"edit","deleted_text":"The Suplier","inserted_text":"The Supp',
    );

    expect(projection.visibleProse).toBe("");
    expect(projection.edits).toEqual([
      { blockIndex: 0, original: "", sealed: false },
    ]);
    expect(projection.safeEdits).toEqual([]);
    expect(projection.protocolStarted).toBe(true);
  });

  test("seals valid JSON edits and keeps prose outside the block", () => {
    const source = `Opening.\n<EDITS>${JSON.stringify([
      edit("The Suplier", "The Supplier", "Typo."),
      edit("goods", "the goods", "Missing article."),
    ])}</EDITS>\nClosing.`;
    const projection = projectRedlineStream(source);

    expect(projection.visibleProse).toBe("Opening.\n\nClosing.");
    expect(projection.edits.map((row) => row.blockIndex)).toEqual([0, 1]);
    expect(projection.safeEdits).toEqual([
      {
        original: "The Suplier",
        replacement: "The Supplier",
        reason: "Typo.",
      },
      {
        original: "goods",
        replacement: "the goods",
        reason: "Missing article.",
      },
    ]);
  });

  test("rejects invalid edit objects", () => {
    const projection = projectRedlineStream(
      `<EDITS>${JSON.stringify([
        { ...edit("valid", "changed"), formats: ["bold"] },
        edit("x".repeat(201), "too long"),
        {
          type: "edit_data",
          kind: "other",
          deleted_text: "a",
          inserted_text: "b",
        },
      ])}</EDITS>`,
    );

    expect(projection.edits).toEqual([
      { blockIndex: 0, original: "", sealed: false },
      { blockIndex: 1, original: "", sealed: false },
      { blockIndex: 2, original: "", sealed: false },
    ]);
    expect(projection.safeEdits).toEqual([]);
  });
});
