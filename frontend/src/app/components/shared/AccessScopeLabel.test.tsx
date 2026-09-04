import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccessScopeLabel } from "./AccessScopeLabel";

describe("AccessScopeLabel", () => {
  it.each([
    ["private", "Private"],
    ["shared", "Shared"],
    ["organization", "Organisation"],
  ] as const)("renders the %s access scope", (scope, label) => {
    const { container } = render(<AccessScopeLabel scope={scope} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("includes the organisation name in the hover description", () => {
    render(
      <AccessScopeLabel
        scope="organization"
        organizationName="Elite Law LLP"
      />,
    );

    expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.getByTitle("Shared with Elite Law LLP")).toBeVisible();
  });

  it.each([
    [0, "1 user"],
    [3, "4 users"],
  ] as const)("renders a direct grant count of %i as %s", (count, label) => {
    render(<AccessScopeLabel scope="shared" directGrantCount={count} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTitle(`Shared with ${label}`)).toBeVisible();
  });
});
