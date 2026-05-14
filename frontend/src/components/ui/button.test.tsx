import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, buttonVariants } from "./button";

describe("Button", () => {
    it("renders as a real <button> by default with text content", () => {
        render(<Button>Click me</Button>);

        const btn = screen.getByRole("button", { name: "Click me" });
        expect(btn.tagName).toBe("BUTTON");
        expect(btn).toHaveAttribute("data-slot", "button");
    });

    it("fires onClick when the user clicks", async () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Go</Button>);

        await userEvent.click(screen.getByRole("button", { name: "Go" }));

        expect(onClick).toHaveBeenCalledOnce();
    });

    it("does not fire onClick when disabled", async () => {
        const onClick = vi.fn();
        render(
            <Button disabled onClick={onClick}>
                Disabled
            </Button>,
        );

        await userEvent.click(screen.getByRole("button", { name: "Disabled" }));

        expect(onClick).not.toHaveBeenCalled();
    });

    it("forwards type='submit' (default html type is 'submit' inside a form, but caller can override)", () => {
        render(<Button type="submit">Submit</Button>);

        expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
    });

    it("renders the asChild element instead of a button when asChild is set", () => {
        // The Slot composition lets callers wrap an <a> so the styles
        // apply but the element semantics stay as a link.
        render(
            <Button asChild>
                <a href="/elsewhere">Link button</a>
            </Button>,
        );

        const link = screen.getByRole("link", { name: "Link button" });
        expect(link.tagName).toBe("A");
        expect(link).toHaveAttribute("href", "/elsewhere");
        expect(link).toHaveAttribute("data-slot", "button");
    });

    it("buttonVariants returns the variant + size class strings", () => {
        // The cva config is callable directly so other components
        // (e.g. asChild link wrappers) can grab the same styling.
        const defaultClasses = buttonVariants();
        const destructive = buttonVariants({ variant: "destructive" });
        const iconSize = buttonVariants({ size: "icon" });

        expect(defaultClasses).toContain("bg-primary");
        expect(destructive).toContain("bg-destructive");
        expect(iconSize).toContain("size-9");
    });
});
