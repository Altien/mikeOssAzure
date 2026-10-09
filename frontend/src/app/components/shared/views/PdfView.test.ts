import { describe, expect, it } from "vitest";
import { configurePdfTextLayer, getObservedPanelWidth } from "./PdfView";

describe("getObservedPanelWidth", () => {
    it("uses the stable border-box width when a scrollbar changes the content box", () => {
        const entry = {
            borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            contentRect: { width: 785 },
        } as unknown as ResizeObserverEntry;

        expect(getObservedPanelWidth(entry)).toBe(800);
    });

    it("falls back to the content-box width for older ResizeObserver implementations", () => {
        const entry = {
            contentRect: { width: 785 },
        } as unknown as ResizeObserverEntry;

        expect(getObservedPanelWidth(entry)).toBe(785);
    });
});

describe("configurePdfTextLayer", () => {
    it("applies the PDF.js 6 scale contract and marks rendered text items", () => {
        const container = document.createElement("div");
        const textDivs = [
            document.createElement("span"),
            document.createElement("span"),
        ];

        configurePdfTextLayer(container, 1.25, textDivs);

        expect(container.style.getPropertyValue("--scale-factor")).toBe("1.25");
        expect(container.style.getPropertyValue("--total-scale-factor")).toBe(
            "1.25",
        );
        // PDF.js sizes the layer with round(..., var(--scale-round-x)) and
        // writes no fallback, so an undefined value collapses the layer to 0x0
        // and clips every highlight.
        expect(container.style.getPropertyValue("--scale-round-x")).toBe("1px");
        expect(container.style.getPropertyValue("--scale-round-y")).toBe("1px");
        expect(
            textDivs.every((textDiv) =>
                textDiv.classList.contains("pdf-text-item"),
            ),
        ).toBe(true);
    });
});
