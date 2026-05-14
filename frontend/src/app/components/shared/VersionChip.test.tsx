import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VersionChip } from "./VersionChip";

describe("VersionChip", () => {
    it("renders 'V<n>' for a positive integer", () => {
        render(<VersionChip n={3} />);

        expect(screen.getByText("V3")).toBeInTheDocument();
    });

    it("renders nothing when n is null", () => {
        const { container } = render(<VersionChip n={null} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when n is undefined", () => {
        const { container } = render(<VersionChip n={undefined} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when n is < 1 (zero is meaningless as a 1-indexed version)", () => {
        const { container } = render(<VersionChip n={0} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when n is NaN / Infinity (Number.isFinite guard)", () => {
        const { container: nan } = render(<VersionChip n={NaN} />);
        expect(nan).toBeEmptyDOMElement();

        const { container: inf } = render(<VersionChip n={Infinity} />);
        expect(inf).toBeEmptyDOMElement();
    });
});
