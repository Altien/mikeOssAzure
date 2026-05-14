import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge, badgeVariants } from "./badge";

describe("Badge", () => {
    it("renders a <span> by default with text content + data-slot", () => {
        render(<Badge>NEW</Badge>);

        const badge = screen.getByText("NEW");
        expect(badge.tagName).toBe("SPAN");
        expect(badge).toHaveAttribute("data-slot", "badge");
    });

    it("renders an <a> when asChild wraps an anchor (style-only composition)", () => {
        render(
            <Badge asChild>
                <a href="/x">Tag</a>
            </Badge>,
        );

        const a = screen.getByRole("link", { name: "Tag" });
        expect(a.tagName).toBe("A");
        expect(a).toHaveAttribute("data-slot", "badge");
    });

    it("badgeVariants exposes the cva class output", () => {
        // Used directly by other components that want the badge's
        // styles without wrapping in <Badge>.
        expect(badgeVariants()).toContain("bg-primary");
        expect(badgeVariants({ variant: "destructive" })).toContain(
            "bg-destructive",
        );
        expect(badgeVariants({ variant: "outline" })).toContain("text-foreground");
    });
});
