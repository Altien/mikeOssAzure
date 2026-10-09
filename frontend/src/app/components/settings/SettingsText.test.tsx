import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsDescription, SettingsLabel } from "./SettingsText";

describe("settings text", () => {
    it("applies the fixed shared label style", () => {
        render(<SettingsLabel>Setting name</SettingsLabel>);

        expect(screen.getByText("Setting name")).toHaveClass(
            "text-sm",
            "font-medium",
            "text-gray-700",
        );
    });

    it("applies the fixed shared description style", () => {
        render(<SettingsDescription>Setting details</SettingsDescription>);

        expect(screen.getByText("Setting details")).toHaveClass(
            "text-sm",
            "text-gray-500",
        );
    });
});
