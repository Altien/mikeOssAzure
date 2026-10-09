import React, { useEffect, useMemo, useState } from "react";
import { ModelToggleUI, nearestReasoningLevelForModel, reasoningLevelsForModel, type ReasoningLevel } from "@mike/model-toggle-ui";
import { getAzureModels, type ApiKeyStatus, type ConfiguredModelOption } from "../../api/mikeApi";
import {
  isModelAvailable,
  routerModelOptions,
  STATIC_MODELS,
  type ModelOption,
  type RouterModelSelections,
} from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  routerModels,
  configuredModels,
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
  /** The user's saved models, per router. */
  routerModels: RouterModelSelections;
  configuredModels: readonly ConfiguredModelOption[];
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
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    const otherModels = [...STATIC_MODELS, ...routerModelOptions(routerModels), ...azureModels];
    const configuredIds = new Set(configuredModels.map((model) => model.id));
    return [...otherModels.filter((model) => !configuredIds.has(model.id)), ...configuredModels].filter(
      (model) =>
        model.source === "Configured" || model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [keyStatus, azureModels, routerModels, configuredModels]);
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
