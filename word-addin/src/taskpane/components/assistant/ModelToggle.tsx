import React, { useEffect, useMemo, useState } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ReasoningLevel,
} from "@mike/model-toggle-ui";
import { getAzureModels, type ApiKeyStatus, type ConfiguredModelOption } from "../../api/mikeApi";
import {
  MODELS, mergeConfiguredModelOptions,
  allRouterModelOptions,
  modelDisplayName,
  type ModelOption,
  type RouterSelections,
} from "@mike/model-catalog";
import { isModelAvailable } from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  routerSelections,
  configuredModels = [],
  compact = false,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No Models". */
  keyStatusLoading?: boolean;
  /** Each router's saved Model Selections; null before the profile loads. */
  routerSelections: RouterSelections | null;
  configuredModels?: readonly ConfiguredModelOption[];
  compact?: boolean;
  onNoModelsClick?: () => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
}): React.ReactElement {
  const [azureModels, setAzureModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getAzureModels()
      .then((models) => {
        if (!cancelled) setAzureModels(models);
      })
      // Local (Ollama) models are an optional extra: when the host is not
      // running there is simply no "Local" group, and nothing the user asked
      // for has failed.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    const routerOptions = allRouterModelOptions(routerSelections ?? {});
    const localOptions = azureModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Azure OpenAI",
    }));
    return mergeConfiguredModelOptions(configuredModels, [
      ...MODELS,
      ...routerOptions,
      ...localOptions,
    ]).filter(
      (model) =>
        model.source === "Configured" || model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [keyStatus, azureModels, routerSelections, configuredModels]);
  const selected = models.find((model) => model.id === value);
  const supportedReasoningLevels = reasoningLevelsForModel(value);
  const normalizedReasoningLevel = reasoningLevel
    ? nearestReasoningLevelForModel(value, reasoningLevel)
    : undefined;

  useEffect(() => {
    if (
      reasoningLevel &&
      normalizedReasoningLevel &&
      normalizedReasoningLevel !== reasoningLevel &&
      onReasoningChange
    ) {
      onReasoningChange(normalizedReasoningLevel);
    }
  }, [normalizedReasoningLevel, onReasoningChange, reasoningLevel]);

  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={models}
      selectedLabel={
        keyStatusLoading
          ? (selected?.label ?? "Select model")
          : (selected?.label ??
            (models.length > 0 ? "Select model" : "No Models"))
      }
      selectedAvailable={selected !== undefined}
      loading={keyStatusLoading}
      compact={compact}
      emptyLabel="No Models"
      onEmptyClick={onNoModelsClick}
      reasoningLevel={normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
    />
  );
}
