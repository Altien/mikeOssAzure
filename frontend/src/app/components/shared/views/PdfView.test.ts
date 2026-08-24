import { describe, expect, it } from "vitest";
import { getObservedPanelWidth } from "./PdfView";

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
