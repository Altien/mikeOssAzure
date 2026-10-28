import { render, screen, within, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgApiKeySettings } from "@/app/lib/mikeApi";

const mocks = vi.hoisted(() => ({
  getOrgApiKeys: vi.fn(),
  saveOrgRouterModels: vi.fn(),
  refreshOrgApiKeys: vi.fn(async () => {}),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ refreshOrgApiKeys: mocks.refreshOrgApiKeys }) }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgApiKeys: mocks.getOrgApiKeys,
  saveOrgRouterModels: mocks.saveOrgRouterModels,
}));
vi.mock("@/app/components/settings/ByokProviderModal", () => ({
  ByokProviderModal: ({ provider, store, onClose }: { provider: { provider: string } | null; store: { routerModels?: { save: (provider: string, models: string[]) => Promise<boolean> } }; onClose: () => void }) => provider ? (
    <div role="dialog" aria-label="Provider model settings">
      <button onClick={() => void store.routerModels?.save(provider.provider, ["vendor/new"])}>Save models</button>
      <button onClick={onClose}>Close</button>
    </div>
  ) : null,
}));
import { OrganizationProviderKeys } from "./OrganizationProviderKeys";

function settings(canManageModels: boolean, saved: boolean): OrgApiKeySettings {
  const keys = { openrouter: saved, sources: { openrouter: saved ? "org" : null }, enabled: { openrouter: true }, settings: {} } as OrgApiKeySettings["keys"];
  return { keys, effective: keys, router_models: { openrouter: ["vendor/existing"] }, effective_router_models: { openrouter: ["vendor/existing"] }, can_manage: true, can_manage_models: canManageModels };
}
const savedSection = () => screen.getByRole("region", { name: "Organization Providers" });
function renderTab(canManageModels = true, saved = true) { return render(<OrganizationProviderKeys orgId="org-1" orgName="Acme LLP" />); }
beforeEach(() => { vi.clearAllMocks(); mocks.getOrgApiKeys.mockResolvedValue(settings(true, true)); mocks.saveOrgRouterModels.mockImplementation(async () => settings(true, true)); });

describe("organization provider credentials", () => {
  it("shows centrally managed provider status without secret editing or enable controls", async () => {
    mocks.getOrgApiKeys.mockResolvedValue(settings(true, true));
    renderTab();
    expect(await within(savedSection()).findByText("On")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add / })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key|service-account key/i)).not.toBeInTheDocument();
  });

  it("does not offer model-list changes to a member", async () => {
    mocks.getOrgApiKeys.mockResolvedValue(settings(false, true));
    renderTab(false, true);
    await within(savedSection()).findByText("On");
    expect(screen.queryByRole("dialog", { name: "Provider model settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("lets the separately authorized manager save a router model list", async () => {
    mocks.getOrgApiKeys.mockResolvedValue(settings(true, true));
    renderTab(true, true);
    fireEvent.click(await within(savedSection()).findByRole("button", { name: /OpenRouter/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save models" }));
    expect(mocks.saveOrgRouterModels).toHaveBeenCalledWith("org-1", "openrouter", ["vendor/new"]);
    await waitFor(() => expect(mocks.refreshOrgApiKeys).toHaveBeenCalledTimes(1));
  });

  it("explains when no central provider is configured", async () => {
    mocks.getOrgApiKeys.mockResolvedValue(settings(true, false));
    renderTab(true, false);
    expect(await screen.findByText("This organization has no centrally managed model providers configured.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add / })).not.toBeInTheDocument();
  });
});
