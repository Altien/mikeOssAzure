"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DROPDOWN_ROWS_CLASS,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import {
  useUserProfile,
  type PreferenceField,
} from "@/app/contexts/UserProfileContext";
import { type ApiKeyState } from "@/app/lib/mikeApi";
import { mergeConfiguredModelOptions } from "@/shared/lib/modelCatalog";
import {
  MODELS,
  SETTINGS_MODELS,
  allRouterModelOptions,
  canonicalModelId,
  routerSelections,
  type ModelOption,
} from "@/shared/lib/modelCatalog";
import {
  REASONING_LEVELS,
  REASONING_LEVEL_LABELS,
  orderedModelGroups,
} from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useAoaiDeployments, type AoaiDeployment } from "@/altien/models/aoaiDeployments";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";

export default function ModelPreferencesPage() {
  const { profile, updateModelPreference } = useUserProfile();
  const aoai = useAoaiDeployments();
  const configuredModels = useConfiguredModels();
  const preferenceModelId = (id: string) =>
    configuredModels.some((model) => model.id === id) ? id : canonicalModelId(id);
  const [savingField, setSavingField] = useState<PreferenceField | null>(
    null,
  );
  const [savedField, setSavedField] = useState<PreferenceField | null>(
    null,
  );
  const [optimisticValues, setOptimisticValues] = useState<
    Partial<Record<PreferenceField, string>>
  >({});
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRouterOptions = allRouterModelOptions(
    profile ? routerSelections(profile) : {},
  );

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handlePreferenceChange = async (field: PreferenceField, id: string) => {
    setOptimisticValues((current) => ({ ...current, [field]: id }));
    setSavedField(null);
    setSavingField(field);
    const ok = await updateModelPreference(field, id || null);
    setSavingField((current) => (current === field ? null : current));
    if (ok) {
      setSavedField(field);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedField((current) => (current === field ? null : current));
      }, 1600);
    } else {
      // The profile context classified the failure and raised the notice with
      // a Retry; here the dropdown only snaps back to the saved value, so the
      // page never shows a preference the server did not accept.
      setOptimisticValues((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>Model Preferences</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Chat title generation</SettingsLabel>
              <SettingsDescription>
                By default, titles use a low cost model from the chat
                provider. Choose a model here to override that.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.titleModel ?? profile?.titleModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...SETTINGS_MODELS,
                ...selectedRouterOptions,

              ])}
              apiKeys={profile?.apiKeys}
              isSaving={savingField === "titleModel"}
              isSaved={savedField === "titleModel"}
              emptyOptionLabel="Automatic — same provider as chat"
              onChange={(id) => handlePreferenceChange("titleModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Tabular review model</SettingsLabel>
              <SettingsDescription>
                Preselected when creating a review. Each review stores its own
                model and can be changed separately.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.tabularModel ?? profile?.tabularModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...MODELS,
                ...selectedRouterOptions,

              ])}
              apiKeys={profile?.apiKeys}
              isSaving={savingField === "tabularModel"}
              isSaved={savedField === "tabularModel"}
              emptyOptionLabel="No default model"
              onChange={(id) => handlePreferenceChange("tabularModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Memory curation model</SettingsLabel>
              <SettingsDescription>
                Used after conversations to identify durable information worth
                keeping. By default, memory uses the model selected for the
                chat.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.memoryCuratorModel ??
                  profile?.memoryCuratorModel ??
                  "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...SETTINGS_MODELS,
                ...selectedRouterOptions,

              ])}
              apiKeys={profile?.apiKeys}
              isSaving={savingField === "memoryCuratorModel"}
              isSaved={savedField === "memoryCuratorModel"}
              emptyOptionLabel="Automatic — use chat model"
              onChange={(id) =>
                handlePreferenceChange("memoryCuratorModel", id)
              }
            />
          </SettingsRow>
        </GlassCardUI>
      </section>

      <section className="space-y-3" aria-labelledby="subagents-heading">
        <SettingsHeading id="subagents-heading">Subagents</SettingsHeading>
        <SettingsDescription>
          Mike can hand parts of a task to subagents that work on them
          separately and report back. These are the defaults it follows unless
          you ask for something else in the chat.
        </SettingsDescription>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Model</SettingsLabel>
              <SettingsDescription>
                The model each subagent runs on. Chosen per task lets Mike
                match the model to the work.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.subagentModel ?? profile?.subagentModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...MODELS,
                ...selectedRouterOptions,

              ])}
              apiKeys={profile?.apiKeys}
              isSaving={savingField === "subagentModel"}
              isSaved={savedField === "subagentModel"}
              emptyOptionLabel="Chosen per task"
              onChange={(id) => handlePreferenceChange("subagentModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Reasoning</SettingsLabel>
              <SettingsDescription>
                How much each subagent thinks before it answers.
              </SettingsDescription>
            </div>
            <ReasoningPreferenceDropdown
              value={
                optimisticValues.subagentReasoning ??
                profile?.subagentReasoning ??
                ""
              }
              isSaving={savingField === "subagentReasoning"}
              isSaved={savedField === "subagentReasoning"}
              emptyOptionLabel="Chosen per task"
              onChange={(level) =>
                handlePreferenceChange("subagentReasoning", level)
              }
            />
          </SettingsRow>
        </GlassCardUI>
      </section>
      <OrganisationModelsNote deployments={aoai.deployments} loading={aoai.loading} error={aoai.error} />
    </div>
  );
}

function ModelPreferenceDropdown({
  value,
  onChange,
  apiKeys,
  options,
  isSaving,
  isSaved,
  emptyOptionLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  apiKeys?: ApiKeyState;
  options: ModelOption[];
  isSaving?: boolean;
  isSaved?: boolean;
  emptyOptionLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const availableOptions = options.filter((model) => {
    if (model.source === "Configured") return true;
    if (model.group === "Local") return true;
    return apiKeys ? isModelAvailable(model.id, apiKeys) : false;
  });
  const selected = availableOptions.find((model) => model.id === value);
  const availableGroups = orderedModelGroups(availableOptions).flatMap(
    (group) => {
      const items = availableOptions.filter((model) => model.group === group);
      return items.length ? [{ group, items }] : [];
    },
  );
  const routeCounts = availableOptions.reduce((counts, model) => {
    const key = `${model.group}\u0000${model.label.toLocaleLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  return (
    <Dropdown onOpenChange={setIsOpen}>
      <PreferenceTrigger
        label={
          !value ? emptyOptionLabel : (selected?.label ?? "Select a model")
        }
        isOpen={isOpen}
        isSaving={isSaving}
        isSaved={isSaved}
      />
      <DropdownContent
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        <DropdownItem
          className="cursor-pointer"
          onSelect={() => onChange("")}
        >
          <span className="flex-1">{emptyOptionLabel}</span>
          {!value && <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />}
        </DropdownItem>
        {availableGroups.length > 0 && <DropdownSeparator />}
        {availableGroups.map(({ group, items }, groupIndex) => {
          return (
            <div key={group} className={DROPDOWN_ROWS_CLASS}>
              {groupIndex > 0 && <DropdownSeparator />}
              <DropdownLabel>
                {group}
              </DropdownLabel>
              {items.map((m) => {
                return (
                  <DropdownItem
                    key={m.id}
                    className="cursor-pointer"
                    onSelect={() => onChange(m.id)}
                  >
                    <span className="flex-1">{m.label}</span>
                    {m.source &&
                      (routeCounts.get(
                        `${m.group}\u0000${m.label.toLocaleLowerCase()}`,
                      ) ?? 0) > 1 && (
                        <span className="text-[9px] font-medium text-gray-400">
                          {m.source}
                        </span>
                      )}
                    {m.id === value && (
                      <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                    )}
                  </DropdownItem>
                );
              })}
            </div>
          );
        })}
      </DropdownContent>
    </Dropdown>
  );
}

function PreferenceTrigger({
  label,
  isOpen,
  isSaving,
  isSaved,
}: {
  label: string;
  isOpen: boolean;
  isSaving?: boolean;
  isSaved?: boolean;
}) {
  return (
    <DropdownTrigger asChild>
      <button
        type="button"
        disabled={isSaving}
        className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate text-gray-900">{label}</span>
        </span>
        {isSaving ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
        ) : isSaved ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
        ) : (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        )}
      </button>
    </DropdownTrigger>
  );
}

function ReasoningPreferenceDropdown({
  value,
  onChange,
  isSaving,
  isSaved,
  emptyOptionLabel,
}: {
  value: string;
  onChange: (level: string) => void;
  isSaving?: boolean;
  isSaved?: boolean;
  emptyOptionLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = REASONING_LEVELS.find((level) => level === value);

  return (
    <Dropdown onOpenChange={setIsOpen}>
      <PreferenceTrigger
        label={selected ? REASONING_LEVEL_LABELS[selected] : emptyOptionLabel}
        isOpen={isOpen}
        isSaving={isSaving}
        isSaved={isSaved}
      />
      <DropdownContent
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        <DropdownItem
          className="cursor-pointer"
          onSelect={() => onChange("")}
        >
          <span className="flex-1">{emptyOptionLabel}</span>
          {!selected && <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />}
        </DropdownItem>
        <DropdownSeparator />
        {REASONING_LEVELS.map((level) => (
          <DropdownItem
            key={level}
            className="cursor-pointer"
            onSelect={() => onChange(level)}
          >
            <span className="flex-1">{REASONING_LEVEL_LABELS[level]}</span>
            {level === selected && (
              <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
            )}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

// Dev-only (OSS-6, §2.3 item 3): provider credentials and the Azure OpenAI
// connection are organisation settings; show where they are managed and
// which AOAI deployments discovery found.
function OrganisationModelsNote({
    deployments,
    loading,
    error,
}: {
    deployments: AoaiDeployment[];
    loading: boolean;
    error: string | null;
}) {
    const installUrl =
        (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
        "/install";
    return (
        <div className="py-6">
            <p className="max-w-xl text-sm text-gray-500">
                Provider credentials and Azure OpenAI connection settings are
                shared by the organisation and managed by an administrator
                through{" "}
                <a
                    href={installUrl}
                    className="font-medium text-gray-700 underline underline-offset-4"
                >
                    organisation setup
                </a>
                . Users can choose from the models the administrator has made
                available.
            </p>
            {loading ? (
                <p className="mt-4 max-w-xl text-xs text-gray-500">
                    Loading deployments…
                </p>
            ) : error ? (
                <p className="mt-4 max-w-xl text-xs text-red-600">
                    Could not list deployments: {error}
                </p>
            ) : deployments.length === 0 ? (
                <p className="mt-4 max-w-xl text-xs text-gray-500">
                    No deployments are visible yet. Ask an administrator to
                    check the Azure OpenAI settings in organisation setup or
                    deploy a model in the configured Azure OpenAI resource.
                </p>
            ) : (
                <div className="mt-4 max-w-xl">
                    <div className="mb-2 text-xs font-medium text-gray-600">
                        Discovered deployments ({deployments.length})
                    </div>
                    <ul className="space-y-1 text-xs text-gray-500">
                        {deployments.map((d) => (
                            <li key={d.name}>
                                <span className="font-mono text-gray-700">
                                    {d.name}
                                </span>
                                {d.model && (
                                    <span className="ml-2 text-gray-400">
                                        → {d.model}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

