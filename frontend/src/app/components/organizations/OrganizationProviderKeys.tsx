"use client";

import { useCallback, useEffect, useState } from "react";
import { ByokProviderModal } from "@/app/components/settings/ByokProviderModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { MODEL_API_KEY_FIELDS, ModelProviderIcon } from "@/app/components/settings/modelProviders";
import { ROUTER_SLUGS, type RouterSlug } from "@/app/components/assistant/ModelToggle";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { routerSelectionsFromLists } from "@/app/hooks/useModelRouterSelections";
import { getOrgApiKeys, saveOrgRouterModels, type ApiKeyProvider, type OrgApiKeySettings } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const LOAD_ERROR = "The organization's model providers could not be loaded.";

export function OrganizationProviderKeys({ orgId, orgName }: { orgId: string; orgName: string }) {
  const { refreshOrgApiKeys } = useWorkspace();
  const [settings, setSettings] = useState<OrgApiKeySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ApiKeyProvider | null>(null);
  const load = useCallback(async () => {
    setLoadError(null);
    try { setSettings(await getOrgApiKeys(orgId)); }
    catch (error) { setLoadError(userFacingApiError(error, LOAD_ERROR)); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);
  const applied = useCallback((next: OrgApiKeySettings) => {
    setSettings(next);
    void refreshOrgApiKeys();
  }, [refreshOrgApiKeys]);
  const loading = settings === null && loadError === null;
  const canManageModels = settings?.can_manage_models === true;
  const hasOrgKey = (provider: ApiKeyProvider) => settings?.keys.sources?.[provider] != null;
  const isEnabled = (provider: ApiKeyProvider) => !!settings?.keys[provider] && settings?.keys.enabled?.[provider] !== false;
  const selected = MODEL_API_KEY_FIELDS.find((field) => field.provider === selectedProvider) ?? null;
  async function saveModels(provider: RouterSlug, models: string[]): Promise<boolean> {
    try { applied(await saveOrgRouterModels(orgId, provider, models)); return true; }
    catch { return false; }
  }
  const renderCard = (field: (typeof MODEL_API_KEY_FIELDS)[number]) => {
    const saved = hasOrgKey(field.provider);
    const supportsModels = (ROUTER_SLUGS as readonly string[]).includes(field.provider);
    return <ConnectorCard key={field.provider} kind="provider" name={field.name}
      icon={<ModelProviderIcon field={field} loading={loading} />}
      onOpen={canManageModels && saved && supportsModels ? () => setSelectedProvider(field.provider) : undefined}
      action={loading ? <span className="block h-5 w-9 animate-pulse rounded-full bg-gray-200" /> :
        <span className="text-sm text-gray-500">{isEnabled(field.provider) ? "On" : "Off"}</span>} />;
  };
  if (loadError) return <div className="space-y-3" role="alert"><SettingsDescription>{loadError}</SettingsDescription><PillButtonUI tone="white" size="sm" onClick={() => void load()}>Try again</PillButtonUI></div>;
  const savedFields = MODEL_API_KEY_FIELDS.filter((field) => !loading && hasOrgKey(field.provider));
  return <>
    <div className="@container space-y-8"><section aria-labelledby="org-providers-saved" className="space-y-3">
      <SettingsHeading id="org-providers-saved">Organization Providers</SettingsHeading>
      <SettingsDescription>Provider credentials are managed centrally by the deployment administrator. Secret editing and personal keys are unavailable here. Organization model lists remain separately manageable where permitted.</SettingsDescription>
      {loading ? <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" /> : savedFields.length === 0 ?
        <SettingsDescription>This organization has no centrally managed model providers configured.</SettingsDescription> :
        <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">{savedFields.map(renderCard)}</div>}
    </section></div>
    {canManageModels ? <ByokProviderModal provider={selected} store={{
      hasSavedKey: selected ? hasOrgKey(selected.provider) : false, settings: settings?.keys.settings,
      save: async () => false, breadcrumb: orgName,
      routerModels: { configured: hasOrgKey, selections: routerSelectionsFromLists(settings?.router_models),
        settings: settings?.keys.settings, save: saveModels, workspace: orgId,
        description: "Edit the models this organization's centrally managed credentials may run. Members see them in model selectors." },
    }} onClose={() => setSelectedProvider(null)} /> : null}
  </>;
}
