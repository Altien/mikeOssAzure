export interface TestWordEdit {
  type: "edit_data";
  kind: "edit";
  deleted_text: string;
  inserted_text?: string;
  formats?: string[];
  occurrence?: "all";
  reason?: string;
}

export function replacementEdit(
  deletedText: string,
  insertedText: string,
  reason?: string,
  occurrence?: "all",
): TestWordEdit {
  return {
    type: "edit_data",
    kind: "edit",
    deleted_text: deletedText,
    inserted_text: insertedText,
    ...(reason ? { reason } : {}),
    ...(occurrence ? { occurrence } : {}),
  };
}

export function formatEdit(
  deletedText: string,
  formats: string[],
  reason?: string,
): TestWordEdit {
  return {
    type: "edit_data",
    kind: "edit",
    deleted_text: deletedText,
    formats,
    ...(reason ? { reason } : {}),
  };
}

export function wordEdits(...edits: TestWordEdit[]): string {
  return `<EDITS>${JSON.stringify(edits)}</EDITS>`;
}
