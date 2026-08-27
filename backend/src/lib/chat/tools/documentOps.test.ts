import { describe, expect, it } from "vitest";
import { reconstructEditablePdfBlocks } from "./documentOps";

describe("editable PDF reconstruction", () => {
  it("reflows legal clauses and removes repeated PDF page furniture", () => {
    const blocks = reconstructEditablePdfBlocks(`[Page 1]
The below form is made available for general informational purposes only,
and is not intended to constitute specific legal advice.

                        MASTER TERMS AND CONDITIONS
                        SOFTWARE-AS-A-SERVICE AGREEMENT

1. DEFINITIONS.

       1.1 “Affiliate” means any entity that controls, is controlled by, or is
under common control with a Party and

           1
This is a source note that wrapped onto another visual line.

                        1
ACC FORM

[Page 2]
The Information is made available for general informational purposes only,
and is not intended to constitute specific legal advice.

continues to satisfy the definition.

       2.1 Access and Use Rights. Client may use the Services for its internal
business purposes.

                        2`);

    expect(blocks).toContainEqual({
      kind: "disclaimer",
      text: "The below form is made available for general informational purposes only, and is not intended to constitute specific legal advice.",
    });
    expect(blocks).toContainEqual({
      kind: "title",
      text: "MASTER TERMS AND CONDITIONS SOFTWARE-AS-A-SERVICE AGREEMENT",
    });
    expect(blocks).toContainEqual({
      kind: "section_heading",
      text: "1. DEFINITIONS.",
    });
    expect(blocks).toContainEqual({
      kind: "clause",
      text: "1.1 “Affiliate” means any entity that controls, is controlled by, or is under common control with a Party and continues to satisfy the definition.",
    });
    expect(blocks).toContainEqual({
      kind: "clause",
      text: "2.1 Access and Use Rights. Client may use the Services for its internal business purposes.",
    });
    expect(blocks.at(-2)).toEqual({
      kind: "source_notes_heading",
      text: "Source Footnotes",
    });
    expect(blocks.at(-1)).toEqual({
      kind: "footnote",
      text: "1 This is a source note that wrapped onto another visual line.",
    });
    expect(JSON.stringify(blocks)).not.toContain("[Page");
    expect(JSON.stringify(blocks).match(/general informational/g)).toHaveLength(
      1,
    );
  });

  it("retains a detected two-column signature block", () => {
    const blocks = reconstructEditablePdfBlocks(`[Page 1]
IN WITNESS WHEREOF, the Parties have executed this Agreement.

CLIENT                SAAS PROVIDER

By:                   By:

Name:                 Name:

Title:                Title:

Date:                 Date:`);

    expect(blocks).toEqual([
      {
        kind: "body",
        text: "IN WITNESS WHEREOF, the Parties have executed this Agreement.",
      },
      { kind: "signature_row", left: "CLIENT", right: "SAAS PROVIDER" },
      { kind: "signature_row", left: "By:", right: "By:" },
      { kind: "signature_row", left: "Name:", right: "Name:" },
      { kind: "signature_row", left: "Title:", right: "Title:" },
      { kind: "signature_row", left: "Date:", right: "Date:" },
    ]);
  });

  it("repairs words hyphenated only by a visual line break", () => {
    const blocks = reconstructEditablePdfBlocks(`[Page 1]
       2.4 Limitations. Client receives a non-
sublicensable right to use the service.`);

    expect(blocks).toEqual([
      {
        kind: "clause",
        text: "2.4 Limitations. Client receives a non-sublicensable right to use the service.",
      },
    ]);
  });

  it("separates adjacent source notes extracted in one visual block", () => {
    const blocks = reconstructEditablePdfBlocks(`[Page 1]
           1
First source note.
           2
Second source note.`);

    expect(blocks).toEqual([
      { kind: "source_notes_heading", text: "Source Footnotes" },
      { kind: "footnote", text: "1 First source note." },
      { kind: "footnote", text: "2 Second source note." },
    ]);
  });
});
