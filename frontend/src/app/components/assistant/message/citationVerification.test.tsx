import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { CitationQuotesHeader } from "../CitationQuotesHeader";
import {
  citationVerificationAriaLabel,
  citationVerificationPillClassName,
  citationVerificationState,
  CitationVerificationBadge,
} from "./citationVerification";

function documentCitation(verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-1",
    filename: "agreement.pdf",
    page: 2,
    quote: "Exact source text",
    quotes: [{ page: 2, quote: "Exact source text" }],
    ...(verified === undefined ? {} : { verified }),
  };
}

const caseCitation: Citation = {
  type: "citation_data",
  kind: "case",
  ref: 2,
  cluster_id: 123,
  case_name: "Example v Example",
  quotes: [],
};

describe("citation verification presentation", () => {
  it("leaves verified document citations in their original gray style", () => {
    const citation = documentCitation(true);
    expect(citationVerificationState(citation)).toBe("verified");
    expect(citationVerificationAriaLabel(citation)).toBe("Citation 1");
    expect(citationVerificationPillClassName(citation)).toBe("");
  });

  it("shows unverified document citations in red without an outline", () => {
    const citation = documentCitation(false);
    expect(citationVerificationState(citation)).toBe("unverified");
    expect(citationVerificationAriaLabel(citation)).toBe(
      "Citation 1. Could not verify quote",
    );
    expect(citationVerificationPillClassName(citation)).toContain("!border-0");
    expect(citationVerificationPillClassName(citation)).toContain(
      "!bg-red-100/85",
    );
  });

  it("leaves citations neutral while verification is not yet available", () => {
    const citation = documentCitation();
    expect(citationVerificationState(citation)).toBe("verified");
    expect(citationVerificationAriaLabel(citation)).toBe("Citation 1");
    expect(citationVerificationPillClassName(citation)).toBe("");
  });

  it("does not apply document verification semantics to case citations", () => {
    expect(citationVerificationState(caseCitation)).toBeNull();
    expect(citationVerificationAriaLabel(caseCitation)).toBe("Citation 2");
    expect(citationVerificationPillClassName(caseCitation)).toBe("");
  });

  it("renders an accessible per-quote warning badge", () => {
    render(<CitationVerificationBadge state="unverified" />);
    const badge = screen.getByText("Could not verify quote");
    expect(badge).toHaveAttribute(
      "title",
      "Quote could not be matched to the extracted document text.",
    );
    expect(badge).toHaveClass("backdrop-blur-xl");
  });

  it("does not render a badge for verified quotes", () => {
    const { container } = render(
      <CitationVerificationBadge state="verified" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows per-quote verification in the citation panel", () => {
    render(
      <CitationQuotesHeader
        quotes={[
          {
            id: "quote-1",
            quote: "Model supplied quote",
            verificationState: "unverified",
          },
        ]}
        activeQuoteId="quote-1"
      />,
    );

    expect(screen.getByText("Could not verify quote")).toBeVisible();
    const quoteButton = screen.getByRole("button", {
      name: /Model supplied quote/,
    });
    expect(quoteButton).toBeDisabled();
    expect(quoteButton).not.toHaveClass("bg-blue-100/70");
  });
});
