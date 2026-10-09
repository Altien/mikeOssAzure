import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecurityPage from "./page";
const state = vi.hoisted(() => ({ authProvider: "supabase" }));
vi.mock("@/app/contexts/ConfigContext", () => ({ useConfig: () => state, useConfigLoading: () => false }));
vi.mock("@/app/components/settings/PasswordSettingsSection", () => ({ PasswordSettingsSection: () => <p>Password controls</p> }));
// Dev drift (sync-log: c94052d7): Entra/local security stays provider-managed.
describe("SecurityPage provider boundary", () => {
  it.each(["entra", "local"])("does not offer password operations for %s", provider => {
    state.authProvider = provider; render(<SecurityPage />);
    expect(screen.queryByText("Password controls")).not.toBeInTheDocument();
  });
  it("shows supported password controls", () => {
    state.authProvider = "supabase"; render(<SecurityPage />);
    expect(screen.getByText("Password controls")).toBeInTheDocument();
  });
});
