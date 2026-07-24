import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { CitationAnnotation } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage citations", () => {
    it("renders a legacy document citation without a filename", () => {
        const legacyCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            document_id: "doc-1",
            page: 1,
            quote: "Legacy citation text",
        } as unknown as CitationAnnotation;

        renderWithProviders(
            <AssistantMessage
                content=""
                annotations={[legacyCitation]}
                citationStatus="final"
            />,
        );

        expect(screen.getByText("Document citation")).toBeInTheDocument();
    });
});
