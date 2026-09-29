import { CircleAlert } from "lucide-react";
import type { Citation, DocumentCitationQuote } from "../../shared/types";

export type CitationVerificationDisplayState = "verified" | "unverified";

type VerificationPresentation = {
  label: string;
  description: string;
  pillClassName: string;
};

const PRESENTATION: Record<
  CitationVerificationDisplayState,
  VerificationPresentation
> = {
  verified: {
    label: "Matched source",
    description: "Quote matched the extracted document text.",
    pillClassName: "",
  },
  unverified: {
    label: "Could not verify quote",
    description: "Quote could not be matched to the extracted document text.",
    pillClassName:
      "!border-0 !bg-red-100/85 !text-red-800 hover:!bg-red-200/80",
  },
};

export function citationVerificationState(
  citation: Citation,
): CitationVerificationDisplayState | null {
  if (citation.kind === "case") return null;
  return citation.verified === false ? "unverified" : "verified";
}

export function quoteVerificationState(
  quote: DocumentCitationQuote,
): CitationVerificationDisplayState {
  return quote.verification?.verified === false ? "unverified" : "verified";
}

export function citationVerificationPillClassName(citation: Citation): string {
  const state = citationVerificationState(citation);
  return state ? PRESENTATION[state].pillClassName : "";
}

export function citationVerificationDescription(
  citation: Citation,
): string | null {
  const state = citationVerificationState(citation);
  return state === "unverified" ? PRESENTATION.unverified.description : null;
}

export function citationVerificationAriaLabel(citation: Citation): string {
  const state = citationVerificationState(citation);
  const suffix =
    state === "unverified" ? `. ${PRESENTATION.unverified.label}` : "";
  return `Citation ${citation.ref}${suffix}`;
}

export function CitationVerificationBadge({
  state,
}: {
  state: CitationVerificationDisplayState;
}) {
  if (state !== "unverified") return null;

  const presentation = PRESENTATION.unverified;
  return (
    <span
      className="inline-flex h-6 w-fit items-center gap-1 rounded-full bg-red-100/55 px-1.5 font-sans text-[10px] font-medium text-red-700 shadow-[0_2px_8px_rgba(185,28,28,0.11),0_1px_2px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.82),inset_0_-3px_7px_rgba(254,202,202,0.32)] backdrop-blur-xl"
      title={presentation.description}
    >
      <CircleAlert className="h-3 w-3" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}
