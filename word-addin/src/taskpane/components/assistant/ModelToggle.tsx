import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { getOllamaModels, type ApiKeyStatus } from "../../api/mikeApi";
import {
  isModelAvailable,
  modelDisplayName,
  openRouterModelOptions,
  vercelModelOptions,
  STATIC_MODELS,
  type ModelGroup,
  type ModelOption,
} from "../../lib/modelCatalog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "../primitives/Dropdown";

const GROUPS: ModelGroup[] = [
  "Anthropic",
  "Google",
  "OpenAI",
  "OpenRouter",
  "Vercel AI Gateway",
  "Local",
];

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  openRouterModels,
  vercelModels,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No API Key". */
  keyStatusLoading?: boolean;
  openRouterModels: string[];
  vercelModels: string[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<ModelGroup | null>(null);
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getOllamaModels()
      .then((models) => {
        if (!cancelled) setOllamaModels(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    const openRouterOptions = openRouterModelOptions(openRouterModels);
    const vercelOptions = vercelModelOptions(vercelModels);
    const localOptions = ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
    }));
    return [...STATIC_MODELS, ...openRouterOptions, ...vercelOptions, ...localOptions].filter(
      (model) =>
        model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [keyStatus, ollamaModels, openRouterModels, vercelModels]);
  const availableGroups = useMemo(
    () =>
      GROUPS.filter((group) =>
        models.some((model) => model.group === group),
      ),
    [models],
  );
  const selected = models.find((model) => model.id === value);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setExpandedGroup(
        selected?.group ??
          (value.startsWith("ollama/") ? "Local" : null) ??
          availableGroups.find((group) =>
            models.some((model) => model.group === group),
          ) ??
          null,
      );
    }
  };

  return (
    <Dropdown open={open} onOpenChange={handleOpenChange}>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label="Choose model"
          title={
            keyStatusLoading
              ? "Checking API keys"
              : models.length === 0
                ? "No API key configured"
                : "Choose model"
          }
          disabled={keyStatusLoading || models.length === 0}
          className={`flex h-8 items-center gap-1.5 rounded-full px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 ${
            open ? "text-gray-700" : ""
          } disabled:cursor-not-allowed disabled:hover:text-gray-400`}
        >
          <span className="max-w-[200px] truncate">
            {keyStatusLoading
              ? (selected?.label ?? "Select model")
              : models.length === 0
                ? "No API Key"
                : (selected?.label ?? "Select model")}
          </span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      </DropdownTrigger>
      <DropdownContent
        side="top"
        align="end"
        sideOffset={8}
        className="max-h-[min(420px,70vh)] w-56 overflow-y-auto"
      >
        {availableGroups.map((group, groupIndex) => {
          const items = models.filter((model) => model.group === group);
          if (items.length === 0) return null;
          const expanded = expandedGroup === group;
          return (
            <React.Fragment key={group}>
              {groupIndex > 0 && <DropdownSeparator />}
              <DropdownItem
                aria-expanded={expanded}
                className="py-2 text-sm font-medium text-gray-700 data-[highlighted]:text-gray-900"
                onSelect={(event) => {
                  event.preventDefault();
                  setExpandedGroup(expanded ? null : group);
                }}
              >
                <span className="flex-1">{group}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-gray-400 transition-transform duration-200 ${
                    expanded ? "rotate-180" : ""
                  }`}
                />
              </DropdownItem>
              {expanded &&
                items.map((model) => {
                  return (
                    <DropdownItem
                      key={model.id}
                      onSelect={() => onChange(model.id)}
                      selected={model.id === value}
                      className="py-1.5 text-sm text-gray-700 data-[highlighted]:text-gray-900"
                    >
                      <span className="flex-1">{model.label}</span>
                      {model.id === value ? (
                        <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                      ) : null}
                    </DropdownItem>
                  );
                })}
            </React.Fragment>
          );
        })}
      </DropdownContent>
    </Dropdown>
  );
}
