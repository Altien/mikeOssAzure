"use client";

import { useState, type ReactNode } from "react";

import { ByokProviderModal } from "@/app/components/settings/ByokProviderModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import {
    MODEL_API_KEY_FIELDS,
    ModelProviderIcon,
    type ModelApiKeyField,
} from "@/app/components/settings/modelProviders";
import { PillButtonUI } from "@mike/ui";
import { InputUI } from "@mike/ui";
import { ToggleSwitchUI } from "@mike/ui";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    MikeApiError,
    saveApiKey,
    type ApiKeyProvider,
    type PooledKeys,
    type PooledKeyStatus,
} from "@/app/lib/mikeApi";
import { reportFault } from "@/app/lib/userFacingError";

/**
 * Pooled mode: the organisation decides who supplies each provider's key. A
 * member may keep their own key only for the models its administrators list.
 */
function PooledProviderCard({
    field,
    status,
    onChanged,
}: {
    field: ModelApiKeyField;
    status: PooledKeyStatus | undefined;
    onChanged: () => Promise<void>;
}) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const models = status?.memberKeyModels ?? [];
    const memberEnabled = models.length > 0;
    const modelList = models.join(", ");
    const lines = [
        status?.organisationKey ? "Provided by your organisation." : null,
        memberEnabled ? `You may use your own key for: ${modelList}.` : null,
        !status?.organisationKey && !memberEnabled
            ? "Keys are managed by your organisation's administrators."
            : null,
    ].filter(Boolean);

    async function save(next: string | null) {
        setBusy(true);
        setError(null);
        try {
            await saveApiKey(field.provider, next);
            setValue("");
            await onChanged();
        } catch (failure) {
            const message =
                failure instanceof MikeApiError
                    ? failure.message
                    : "The key could not be saved. Please try again.";
            setError(message);
        } finally {
            setBusy(false);
        }
    }

    const keyLabel = `${field.name} API key`;
    const action = !memberEnabled ? null : status?.memberKeySet ? (
        <PillButtonUI
            tone="blue"
            size="sm"
            disabled={busy}
            aria-label={`Remove your ${field.name} key`}
            onClick={() => void save(null)}
        >
            Remove
        </PillButtonUI>
    ) : (
        <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (value.trim()) void save(value);
            }}
        >
            <InputUI
                type="password"
                autoComplete="off"
                aria-label={keyLabel}
                placeholder="Your key"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="w-40"
            />
            <PillButtonUI
                tone="blue"
                size="sm"
                type="submit"
                disabled={busy || !value.trim()}
            >
                Save
            </PillButtonUI>
        </form>
    );
    const savedLine = memberEnabled && status?.memberKeySet ? " Your key is saved." : "";
    const detailText = lines.join(" ") + savedLine;
    return (
        <div className="space-y-1">
            <ConnectorCard
                kind="provider"
                name={field.name}
                icon={<ModelProviderIcon field={field} loading={false} />}
                detail={detailText}
                action={action}
            />
            {error ? (
                <p role="alert" className="text-sm text-red-600">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

function PooledProviders({ pooledKeys }: { pooledKeys: PooledKeys }) {
    const { reloadProfile } = useUserProfile();
    return (
        <div className="@container space-y-8">
            <SettingsDescription>
                Your organisation decides who supplies each provider&apos;s key.
                Your own key is used only for the models listed with it.
            </SettingsDescription>
            <div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-2">
                {MODEL_API_KEY_FIELDS.map((field) => (
                    <PooledProviderCard
                        key={field.provider}
                        field={field}
                        status={pooledKeys[field.provider]}
                        onChanged={reloadProfile}
                    />
                ))}
            </div>
        </div>
    );
}
/**
 * A provider is listed as saved once the user has saved their own key for it. It
 * stays there while switched off, so the switch does not move under the
 * pointer and the provider can be switched back on.
 */
const PROVIDER_SECTIONS = [
    {
        id: "active",
        active: true,
        title: "Saved Providers",
        empty: "No managed providers configured. Contact your deployment administrator.",
    },
    {
        id: "available",
        active: false,
        title: "Available Providers",
        empty: "Every provider has a key saved.",
    },
] as const;

/**
 * The caller's own model provider keys: the Saved and Available provider
 * grids, the provider dialog and its on/off switches. Rendered by Settings →
 * API Keys and by the last onboarding step, so a key saved in
 * either place goes through the same checks.
 *
 * Upstream divergence (sync-log: 81a59c04): Dev keeps its pooled-tenancy
 * branch (organisation-governed keys) here, so both callers honour it, and
 * keeps its managed-provider cards ("Configured", `noPersonalSwitch`). Dev
 * has no MFA step-up popup (Entra/local sessions), so upstream's
 * MfaVerificationPopup retry around the switch is not carried.
 */
export function PersonalProviderKeys({
    intro = null,
}: {
    /** A sentence above the grids, where the page needs one. */
    intro?: ReactNode;
}) {
    const { profile, loading, updateApiKeyEnabled } = useUserProfile();
    const [busyProvider, setBusyProvider] = useState<ApiKeyProvider | null>(null);
    const [toggleError, setToggleError] = useState<string | null>(null);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(
        null,
    );
    const selected = MODEL_API_KEY_FIELDS.find(
        (field) => field.provider === selectedProvider,
    );

    async function toggleProvider(provider: ApiKeyProvider, enabled: boolean) {
        setBusyProvider(provider);
        setToggleError(null);
        try {
            const saved = await updateApiKeyEnabled(provider, enabled);
            if (!saved) setToggleError("The provider could not be updated. Please try again.");
        } catch (error) {
            // The message is fixed; the report keeps the fault's identity.
            reportFault(error, { operation: "settings.keys" });
            setToggleError("The provider could not be updated. Please try again.");
        } finally {
            setBusyProvider(null);
        }
    }

    const renderToggle = (field: ModelApiKeyField, label: string) => (
        <ToggleSwitchUI
            checked={profile?.apiKeys[field.provider]?.enabled !== false}
            disabled={busyProvider !== null}
            aria-busy={busyProvider === field.provider}
            aria-label={label}
            onCheckedChange={(enabled) =>
                void toggleProvider(field.provider, enabled)
            }
        />
    );

    const renderCard = (field: ModelApiKeyField) => {
        const hasSavedKey =
            profile?.apiKeys[field.provider]?.source != null;
        const blocked = loading || busyProvider === field.provider;
        const open = () => {
            if (!blocked) setSelectedProvider(field.provider);
        };
        return (
            <ConnectorCard
                key={field.provider}
                kind="provider"
                name={field.name}
                icon={<ModelProviderIcon field={field} loading={loading} />}
                // Like connectors: a saved provider opens from anywhere on
                // its card, an available one only from its Add button.
                onOpen={hasSavedKey ? open : undefined}
                action={
                    hasSavedKey ? (
                        field.noPersonalSwitch ? (
                            <span className="text-sm text-gray-500">Configured</span>
                        ) : (
                            renderToggle(field, `${field.name} provider`)
                        )
                    ) : (
                        <PillButtonUI
                            tone="blue"
                            size="sm"
                            disabled={blocked}
                            aria-label={`Add ${field.name}`}
                            aria-haspopup="dialog"
                            onClick={open}
                        >
                            Add
                        </PillButtonUI>
                    )
                }
            />
        );
    };

    const pooledKeys = profile?.pooledKeys;
    if (!loading && pooledKeys) return <PooledProviders pooledKeys={pooledKeys} />;

    return (
        <div className="@container space-y-8">
            {intro}
            {PROVIDER_SECTIONS.map((section) => {
                // While the profile loads, which providers are active is not
                // known yet: every card waits in the second section.
                const fields = MODEL_API_KEY_FIELDS.filter(
                    (field) =>
                        (!loading &&
                            profile?.apiKeys[field.provider]?.source ===
                                "user") === section.active,
                );
                const headingId = `byok-${section.id}-providers`;
                return (
                    <section
                        key={section.id}
                        aria-labelledby={headingId}
                        className="space-y-3"
                    >
                        <SettingsHeading id={headingId}>
                            {section.title}
                        </SettingsHeading>
                        {loading && section.active ? (
                            <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" />
                        ) : fields.length === 0 ? (
                            <SettingsDescription>
                                {section.empty}
                            </SettingsDescription>
                        ) : (
                            <div
                                className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2"
                                aria-busy={loading}
                            >
                                {fields.map(renderCard)}
                            </div>
                        )}
                    </section>
                );
            })}
            <ByokProviderModal
                provider={selected ?? null}
                enabledToggle={
                    selected &&
                    profile?.apiKeys[selected.provider]?.source === "user"
                        ? renderToggle(selected, `Use ${selected.name}`)
                        : undefined
                }
                onClose={() => setSelectedProvider(null)}
            />
            <WarningPopup
                open={toggleError !== null}
                title="Provider update failed"
                message={toggleError}
                onClose={() => setToggleError(null)}
            />
        </div>
    );
}
