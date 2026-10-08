"use client";

import type { ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { RouterSettingsSection } from "./RouterSettingsSection";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyProvider } from "@/app/lib/mikeApi";
import { ROUTER_SLUGS, type RouterSlug } from "@/app/components/assistant/ModelToggle";

export type ByokProvider = {
  provider: ApiKeyProvider;
  name: string;
  label: string;
  keyLabel?: string;
};

// Upstream divergence (sync-log: 25779536): retain the provider modal and
// model selections, but shared credentials are managed only by an administrator.
// The switch changes this user's preference and never edits Key Vault secrets.
export function ByokProviderModal({ provider, enabledToggle, onClose }: {
  provider: ByokProvider | null;
  enabledToggle?: ReactNode;
  onClose: () => void;
}) {
  const { profile } = useUserProfile();
  if (!provider) return null;
  const hasModelSelections = (ROUTER_SLUGS as readonly string[]).includes(provider.provider);
  const configured = profile?.apiKeys[provider.provider]?.source != null;
  const installUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") + "/install";
  return (
    <Modal open onClose={onClose} breadcrumbs={["Model Providers", provider.name]}
      size={hasModelSelections ? "md" : "sm"} className="h-auto max-h-[calc(100vh-2rem)]">
      <div data-modal-scroll="vertical" className="min-h-0 min-w-0 space-y-6 overflow-y-auto pb-4">
        {enabledToggle && (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm font-medium text-gray-700">Enabled for your account</p>
            <div className="shrink-0">{enabledToggle}</div>
          </div>
        )}
        <p className="text-sm text-gray-500">
          Credentials are shared by this organisation and managed by an administrator.
          Your provider switch and model selections affect only your account.
        </p>
        <a href={installUrl} className="inline-flex text-sm font-medium text-gray-700 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40">
          Open organisation setup
        </a>
        {hasModelSelections && configured && (
          <RouterSettingsSection provider={provider.provider as RouterSlug} />
        )}
      </div>
    </Modal>
  );
}
