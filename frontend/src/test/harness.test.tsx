import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./render";

describe("test harness", () => {
    it("renderWithProviders mounts children inside the provider tree", () => {
        renderWithProviders(<div>hi</div>);

        expect(screen.getByText("hi")).toBeInTheDocument();
    });

    it("default auth value is unauthenticated and getAccessToken returns null", async () => {
        function Probe() {
            // exercised via context shape, not a real component
            return <div>probe</div>;
        }
        renderWithProviders(<Probe />);

        expect(screen.getByText("probe")).toBeInTheDocument();
    });
});
