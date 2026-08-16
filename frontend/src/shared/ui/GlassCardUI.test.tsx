import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    GLASS_CARD_SURFACE_CLASS,
    GlassCardUI,
} from "./GlassCardUI";

describe("GlassCardUI", () => {
    it("renders the shared glass surface around its children", () => {
        render(
            <GlassCardUI>
                <p>Shared content</p>
            </GlassCardUI>,
        );

        expect(screen.getByText("Shared content").parentElement).toHaveClass(
            ...GLASS_CARD_SURFACE_CLASS.split(" "),
        );
    });
});
