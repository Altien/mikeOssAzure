import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_PROVIDERS } from "@/app/lib/apiKeyState";
import { MikeApiError, type OrgApiKeySettings } from "@/app/lib/mikeApi";

const mocks = vi.hoisted(() => ({
  getOrgApiKeys: vi.fn(),
  saveOrgApiKey: vi.fn(),
  setOrgApiKeyEnabled: vi.fn(),
  setOrgPersonalApiKeysAllowed: vi.fn(),
  refreshOrgApiKeys: vi.fn(async () => {}),
  updateApiKey: vi.fn(async () => true),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: ({
    open,
    onVerified,
  }: {
    open: boolean;
    onVerified: () => void;
  }) =>
    open ? (
      <button type="button" onClick={onVerified}>
        Verify MFA
      </button>
    ) : null,
  needsMfaVerification: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/app/components/settings/RouterSettingsSection", () => ({
  RouterSettingsSection: () => <div data-testid="model-selections" />,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrgApiKeys: mocks.refreshOrgApiKeys }),
}));
// The key dialog is shared with a person's own keys. Here it must never
// read or write them.
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: {
      apiKeys: Object.fromEntries(
        API_KEY_PROVIDERS.map((provider) => [
          provider,
          { configured: true, enabled: true, source: "user" },
        ]),
      ),
      apiKeySettings: { bedrock: { region: "personal-region" } },
    },
    updateApiKey: mocks.updateApiKey,
  }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgApiKeys: mocks.getOrgApiKeys,
  saveOrgApiKey: mocks.saveOrgApiKey,
  setOrgApiKeyEnabled: mocks.setOrgApiKeyEnabled,
  setOrgPersonalApiKeysAllowed: mocks.setOrgPersonalApiKeysAllowed,
}));

import { OrganizationProviderKeys } from "./OrganizationProviderKeys";

type Saved = Record<string, { enabled?: boolean; settings?: object }>;

/** The server's answer for an organization with these saved providers. */
function orgSettings(
  saved: Saved,
  overrides: Partial<OrgApiKeySettings> = {},
): OrgApiKeySettings {
  const keys: Record<string, unknown> = Object.fromEntries(
    API_KEY_PROVIDERS.map((provider) => [provider, false]),
  );
  const sources: Record<string, string | null> = {};
  const enabled: Record<string, boolean> = {};
  const settings: Record<string, object> = {};
  for (const [provider, row] of Object.entries(saved)) {
    keys[provider] = row.enabled !== false;
    sources[provider] = "org";
    enabled[provider] = row.enabled !== false;
    if (row.settings) settings[provider] = row.settings;
  }
  const status = { ...keys, sources, enabled, settings };
  return {
    keys: status,
    effective: status,
    allow_personal_api_keys: true,
    can_manage: true,
    ...overrides,
  } as OrgApiKeySettings;
}

const renderTab = () =>
  render(<OrganizationProviderKeys orgId="org-1" orgName="Acme LLP" />);
const savedSection = () =>
  screen.getByRole("region", { name: "Organization Providers" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgApiKeys.mockResolvedValue(orgSettings({}));
});

describe("an owner or admin", () => {
  it("lists what is saved apart from what can be added", async () => {
    mocks.getOrgApiKeys.mockResolvedValue(orgSettings({ openai: {} }));
    renderTab();

    expect(
      await within(savedSection()).findByRole("switch", {
        name: "OpenAI provider",
      }),
    ).toBeChecked();
    const available = screen.getByRole("region", {
      name: "Available Providers",
    });
    expect(
      within(available).getByRole("button", { name: "Add Anthropic (Claude)" }),
    ).toBeInTheDocument();
    expect(
      within(available).queryByRole("button", { name: "Add OpenAI" }),
    ).not.toBeInTheDocument();
    expect(mocks.getOrgApiKeys).toHaveBeenCalledExactlyOnceWith("org-1");
  });

  it("saves a key for the organization, not for themselves", async () => {
    const user = userEvent.setup();
    mocks.saveOrgApiKey.mockResolvedValue(orgSettings({ openai: {} }));
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Add OpenAI" }));
    // The caller has a key of their own for every provider; the dialog is
    // about the organization's, which has none.
    await user.type(screen.getByLabelText("OpenAI API Key"), " sk-org ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.saveOrgApiKey).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "openai",
        "sk-org",
        undefined,
      ),
    );
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
    expect(
      await within(savedSection()).findByRole("switch", {
        name: "OpenAI provider",
      }),
    ).toBeChecked();
    // The model pickers are told the workspace's keys changed.
    expect(mocks.refreshOrgApiKeys).toHaveBeenCalledTimes(1);
  });

  it("saves a cloud key with the organization's own setting", async () => {
    const user = userEvent.setup();
    mocks.saveOrgApiKey.mockResolvedValue(
      orgSettings({ bedrock: { settings: { region: "eu-west-2" } } }),
    );
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Add Amazon Bedrock" }),
    );
    // Not prefilled from the caller's personal region.
    expect(screen.getByLabelText("AWS region")).toHaveValue("");
    await user.type(screen.getByLabelText("Amazon Bedrock API Key"), "key");
    await user.type(screen.getByLabelText("AWS region"), "eu-west-2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.saveOrgApiKey).toHaveBeenCalledWith(
        "org-1",
        "bedrock",
        "key",
        { region: "eu-west-2" },
      ),
    );
  });

  it("names the organization in the dialog and offers no model selections", async () => {
    const user = userEvent.setup();
    mocks.getOrgApiKeys.mockResolvedValue(orgSettings({ openrouter: {} }));
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Manage OpenRouter" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Acme LLP")).toBeInTheDocument();
    // Model Selections are each person's own.
    expect(screen.queryByTestId("model-selections")).not.toBeInTheDocument();
  });

  it("clears a saved key", async () => {
    const user = userEvent.setup();
    mocks.getOrgApiKeys.mockResolvedValue(orgSettings({ openai: {} }));
    mocks.saveOrgApiKey.mockResolvedValue(orgSettings({}));
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Manage OpenAI" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(mocks.saveOrgApiKey).toHaveBeenCalledWith(
        "org-1",
        "openai",
        null,
        undefined,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("button", { name: "Add OpenAI" }),
    ).toBeInTheDocument();
  });

  it("switches a provider off without removing its key", async () => {
    const user = userEvent.setup();
    mocks.getOrgApiKeys.mockResolvedValue(orgSettings({ openai: {} }));
    mocks.setOrgApiKeyEnabled.mockResolvedValue(
      orgSettings({ openai: { enabled: false } }),
    );
    renderTab();

    const toggle = await screen.findByRole("switch", { name: "OpenAI provider" });
    await user.click(toggle);

    expect(mocks.setOrgApiKeyEnabled).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "openai",
      false,
    );
    // Off, it keeps its key and its place under the organization's providers.
    expect(
      await within(savedSection()).findByRole("switch", {
        name: "OpenAI provider",
      }),
    ).not.toBeChecked();
    expect(mocks.refreshOrgApiKeys).toHaveBeenCalledTimes(1);
  });

  it("stops members' own keys being used", async () => {
    const user = userEvent.setup();
    mocks.setOrgPersonalApiKeysAllowed.mockResolvedValue(
      orgSettings({}, { allow_personal_api_keys: false }),
    );
    renderTab();

    const toggle = await screen.findByRole("switch", {
      name: "Allow members' own keys",
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(mocks.setOrgPersonalApiKeysAllowed).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      false,
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(
      screen.getByText(
        "A member's own keys are never used for work in this organization.",
      ),
    ).toBeInTheDocument();
  });

  it("asks for MFA and then carries out the change", async () => {
    const user = userEvent.setup();
    mocks.setOrgPersonalApiKeysAllowed
      .mockRejectedValueOnce(
        new MikeApiError({
          message: "MFA required",
          status: 403,
          code: "mfa_verification_required",
        }),
      )
      .mockResolvedValueOnce(
        orgSettings({}, { allow_personal_api_keys: false }),
      );
    renderTab();

    await user.click(
      await screen.findByRole("switch", { name: "Allow members' own keys" }),
    );
    await user.click(await screen.findByRole("button", { name: "Verify MFA" }));

    await waitFor(() =>
      expect(mocks.setOrgPersonalApiKeysAllowed).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Allow members' own keys" }),
      ).not.toBeChecked(),
    );
  });

  it("says so when a change fails, and leaves the switch where it was", async () => {
    const user = userEvent.setup();
    mocks.getOrgApiKeys.mockResolvedValue(orgSettings({ openai: {} }));
    mocks.setOrgApiKeyEnabled.mockRejectedValue(new Error("boom"));
    renderTab();

    await user.click(
      await screen.findByRole("switch", { name: "OpenAI provider" }),
    );

    expect(
      await screen.findByText(
        "The provider could not be updated. Please try again.",
      ),
    ).toBeInTheDocument();
    // Nothing internal reaches the page.
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "OpenAI provider" })).toBeChecked();
    expect(mocks.refreshOrgApiKeys).not.toHaveBeenCalled();
  });
});

describe("a member who cannot manage the organization", () => {
  const asMember = (saved: Saved, allowPersonal = true) =>
    mocks.getOrgApiKeys.mockResolvedValue(
      orgSettings(saved, {
        can_manage: false,
        allow_personal_api_keys: allowPersonal,
      }),
    );

  it("sees what is set up and can change none of it", async () => {
    asMember({ openai: {}, claude: { enabled: false } }, false);
    renderTab();

    const saved = savedSection();
    expect(await within(saved).findByText("OpenAI")).toBeInTheDocument();
    expect(within(saved).getByText("Anthropic (Claude)")).toBeInTheDocument();
    // Status as plain text, not a control.
    expect(within(saved).getByText("On")).toBeInTheDocument();
    expect(within(saved).getByText("Off")).toBeInTheDocument();

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Add|Manage) / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Available Providers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "A member's own keys are never used for work in this organization.",
      ),
    ).toBeInTheDocument();
  });

  it("is told when nothing has been set up", async () => {
    asMember({});
    renderTab();

    expect(
      await screen.findByText(
        "This organization has not set up a model provider yet.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A member's own key is used for a provider the organization has not set up.",
      ),
    ).toBeInTheDocument();
  });
});

describe("loading and failure", () => {
  it("offers nothing to press until the organization's keys are known", () => {
    mocks.getOrgApiKeys.mockReturnValue(new Promise(() => {}));
    renderTab();

    // The cards wait in the second section, as on the personal page. What
    // each one's control is depends on the caller's role, so none is drawn —
    // and nothing claims a provider is on or off.
    const available = screen.getByRole("region", {
      name: "Available Providers",
    });
    expect(within(available).getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/^(On|Off)$/)).not.toBeInTheDocument();
  });

  it("offers a retry when the keys cannot be loaded", async () => {
    const user = userEvent.setup();
    mocks.getOrgApiKeys
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(orgSettings({ openai: {} }));
    renderTab();

    expect(
      await screen.findByText(
        "The organization's model providers could not be loaded.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("switch", { name: "OpenAI provider" }),
    ).toBeInTheDocument();
  });
});
