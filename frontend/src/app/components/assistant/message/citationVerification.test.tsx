import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { CitationQuotesSection } from "../CitationQuotesSection";
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

  it("uses the red error style for unverified citations", () => {
    const citation = documentCitation(false);
    expect(citationVerificationState(citation)).toBe("unverified");
    expect(citationVerificationAriaLabel(citation)).toBe(
      "Citation 1. Could not verify quote",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "!bg-red-100/85",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "!text-red-800",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "dark:!bg-red-950",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "dark:!text-white",
    );
  });

  it("leaves citations neutral while verification is not yet available", () => {
    const citation = documentCitation();
    expect(citationVerificationState(citation)).toBe("verified");
    expect(citationVerificationAriaLabel(citation)).toBe("Citation 1");
    expect(citationVerificationPillClassName(citation)).toBe("");
  });

  it("applies source verification semantics to case citations", () => {
    expect(citationVerificationState(caseCitation)).toBe("verified");
    expect(citationVerificationAriaLabel(caseCitation)).toBe("Citation 2");
    expect(citationVerificationPillClassName(caseCitation)).toBe("");

    const unverifiedCase = { ...caseCitation, verified: false };
    expect(citationVerificationState(unverifiedCase)).toBe("unverified");
    expect(citationVerificationAriaLabel(unverifiedCase)).toBe(
      "Citation 2. Could not verify quote",
    );
  });

  it("reveals an explanation from the white warning pill", async () => {
    const user = userEvent.setup();
    render(<CitationVerificationBadge state="unverified" />);
    const trigger = screen.getByRole("button", {
      name: "Could not verify quote",
    });
    expect(trigger).toHaveClass("liquid-glass-flat", "!text-red-600");
    expect(trigger).not.toHaveClass("bg-red-600/90");
    expect(
      screen.queryByText("Quote not found in document"),
    ).not.toBeInTheDocument();

    await user.click(trigger);

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Quote not found in document")).toBeVisible();
    expect(
      screen.getByText(/Treat it as hallucinated/),
    ).toHaveTextContent(
      "double-check the related section of the assistant response",
    );
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("does not render a badge for verified quotes", () => {
    const { container } = render(
      <CitationVerificationBadge state="verified" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows per-quote verification in the citation panel", () => {
    render(
      <CitationQuotesSection
        citationRef={7}
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

    expect(screen.getByLabelText("Citation 7")).toHaveTextContent("7");
    expect(screen.queryByText("Citation")).not.toBeInTheDocument();
    expect(screen.getByText("Could not verify quote")).toBeVisible();
    expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
    expect(screen.getByText(/Model supplied quote/)).not.toHaveClass(
      "citation-quote-selected",
    );
  });

  it("formats normalized document quotes inside the quote section", () => {
    render(
      <CitationQuotesSection
        document={{
          document_id: "spreadsheet-1",
          title: "Damages.xlsx",
          type: "spreadsheet",
          metadata: [],
          quotes: [
            {
              quote: "1,250,000",
              target: { sheet: "Summary", cell: "B7" },
              verification: { verified: true },
            },
          ],
        }}
        activeQuoteId="spreadsheet-1:quote:0"
        citationRef={4}
      />,
    );

    expect(screen.getByText(/1,250,000/)).toHaveTextContent(
      "“1,250,000” (Summary, cell B7)",
    );
    expect(screen.getByLabelText("Citation 4")).toHaveTextContent("4");
  });
});
