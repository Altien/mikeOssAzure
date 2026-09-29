import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { citationTooltip, CitationsBlock } from "./CitationSources";

function documentCitation(ref: number, verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref,
    doc_id: `doc-${ref}`,
    document_id: `document-${ref}`,
    filename: `source-${ref}.pdf`,
    page: ref,
    quote: `Quote ${ref}`,
    quotes: [{ page: ref, quote: `Quote ${ref}` }],
    ...(verified === undefined ? {} : { verified }),
  };
}

describe("CitationsBlock verification states", () => {
  it("marks only unverified document citation buttons", () => {
    render(
      <CitationsBlock
        citations={[documentCitation(1, false), documentCitation(2)]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Citation 1. Could not verify quote",
      }),
    ).toHaveClass("!border-0", "!bg-red-100/85");
    const verifiedButton = screen.getByRole("button", {
      name: "Citation 2",
    });
    expect(verifiedButton).toHaveClass("border-gray-200/60", "bg-gray-200/80");
    expect(verifiedButton).not.toHaveClass("!bg-red-100/85");
  });

  it("includes only unverified warnings in citation tooltips", () => {
    expect(citationTooltip(documentCitation(3, false))).toContain(
      "Quote could not be matched to the extracted document text.",
    );
    expect(citationTooltip(documentCitation(3, true))).not.toContain("matched");
  });

  it("leaves case citations outside document verification styling", () => {
    const citation: Citation = {
      type: "citation_data",
      kind: "case",
      ref: 4,
      cluster_id: 99,
      case_name: "Example v Example",
      quotes: [],
    };
    render(<CitationsBlock citations={[citation]} />);

    const button = screen.getByRole("button", { name: "Citation 4" });
    expect(button).not.toHaveClass("!bg-red-100/85");
  });
});
