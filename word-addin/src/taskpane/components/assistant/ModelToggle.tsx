import React, { useEffect, useMemo, useState } from "react";
import { ModelToggleUI } from "@mike/model-toggle-ui";
import { getAzureModels, type ApiKeyStatus } from "../../api/mikeApi";
import {
  isModelAvailable,
  openRouterModelOptions,
  vercelModelOptions,
  STATIC_MODELS,
  type ModelOption,
} from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  openRouterModels,
  vercelModels,
  compact = false,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No API Key". */
  keyStatusLoading?: boolean;
  openRouterModels: string[];
  vercelModels: string[];
  compact?: boolean;
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
    const openRouterOptions = openRouterModelOptions(openRouterModels);
    const vercelOptions = vercelModelOptions(vercelModels);
    const localOptions = azureModels;
    return [
      ...STATIC_MODELS,
      ...openRouterOptions,
      ...vercelOptions,
      ...localOptions,
    ].filter(
      (model) =>
        model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [keyStatus, azureModels, openRouterModels, vercelModels]);
  const selected = models.find((model) => model.id === value);

  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={models}
      selectedLabel={
        keyStatusLoading
          ? (selected?.label ?? "Select model")
          : (selected?.label ??
            (models.length > 0 ? "Select model" : "No API Key"))
      }
      selectedAvailable={selected !== undefined}
      loading={keyStatusLoading}
      compact={compact}
    />
  );
}
