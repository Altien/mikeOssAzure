import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrgPreferences,
  getWebSearchSettings,
  saveOrgApiKey,
  updateWebSearchSettings,
} from "@/app/lib/mikeApi";
import { OrganizationWebSearchSection } from "./WebSearchSection";

// An organization's web search settings govern work in its workspace: they
// are read and saved as the organization's, its model keys decide which
// families can search, and a search service's key is the organization's.

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgPreferences: vi.fn(),
  getWebSearchSettings: vi.fn(),
  updateWebSearchSettings: vi.fn(),
  saveOrgApiKey: vi.fn(),
}));

const workspace = vi.hoisted(() => ({
  refreshOrgApiKeys: vi.fn(async () => {}),
  orgApiKeys: { keys: {} } as {
    keys: Record<string, unknown> & { sources?: Record<string, string | null> };
  },
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => workspace,
}));

// The organization's keys: OpenAI, not Claude.
vi.mock("@/app/hooks/useModelApiKeys", () => ({
  useModelApiKeys: () =>
    Object.fromEntries(
      ["claude", "openai", "brave", "tavily", "deepseek"].map((provider) => [
        provider,
        { configured: provider === "openai", enabled: true, source: "org" },
      ]),
    ),
}));

// Dev: no app-level MFA popup (sync-log 3a10943); the card fences its
// writes to the signed-in identity.
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "test-user" } }),
}));

// The caller's own settings are never read here.
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => {
    throw new Error("the caller's profile is not used here");
  },
}));

const SETTINGS = {
  enabled: true,
  claude: "provider",
  openai: "provider",
  other: "brave",
} as const;

const save = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  workspace.orgApiKeys = { keys: {} };
  vi.mocked(getOrgPreferences).mockResolvedValue({
    web_search: SETTINGS,
  } as never);
  save.mockImplementation(async (update: { web_search: object }) => ({
    web_search: { ...SETTINGS, ...update.web_search },
  }));
});

describe("OrganizationWebSearchSection", () => {
  it("shows the organization's settings, for the families its keys can run", async () => {
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);

    expect(
      await screen.findByRole("button", { name: "OpenAI models" }),
    ).toHaveTextContent("OpenAI Search");
    expect(screen.queryByRole("button", { name: "Claude models" })).toBeNull();
    expect(getOrgPreferences).toHaveBeenCalledWith(
      "org-1",
      expect.any(AbortSignal),
    );
    expect(getWebSearchSettings).not.toHaveBeenCalled();
  });

  it("saves a change as the organization's", async () => {
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);
    const toggle = await screen.findByRole("switch", {
      name: "Enable web search",
    });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ web_search: { enabled: false } }),
    );
    expect(updateWebSearchSettings).not.toHaveBeenCalled();
  });

  // Upstream divergence (sync-log: 74745a6f): upstream lets the organization
  // enter and remove its search-service key here. Dev177 keeps search-service
  // credentials administrator-managed, so the row only reports their state.
  it("reports the search service's key as administrator-managed", async () => {
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);

    expect(await screen.findByText("Brave Search API Key")).toBeInTheDocument();
    expect(screen.getByText("Managed by your organization.")).toBeInTheDocument();
    // The organization's keys (mocked above) have no Brave key.
    expect(screen.getByText("Administrator action required")).toBeInTheDocument();
    expect(screen.queryByLabelText("Brave Search API Key")).toBeNull();
    expect(saveOrgApiKey).not.toHaveBeenCalled();
  });
});
