import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { getOllamaModels, type ApiKeyStatus } from "../../api/mikeApi";
import {
  isModelAvailable,
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

const GROUPS: ModelGroup[] = ["Anthropic", "Google", "OpenAI", "Local"];

export function ModelToggle({
  value,
  onChange,
  keyStatus,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
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

  const models = useMemo(
    () => [...STATIC_MODELS, ...ollamaModels],
    [ollamaModels],
  );
  const selected = models.find((model) => model.id === value);
  const selectedAvailable = isModelAvailable(value, keyStatus);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setExpandedGroup(
        selected?.group ??
          (value.startsWith("ollama/") ? "Local" : null) ??
          GROUPS.find((group) =>
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
            selectedAvailable
              ? "Choose model"
              : "API key missing for selected model"
          }
          className={`flex h-8 items-center gap-1.5 rounded-full px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 ${
            open ? "text-gray-700" : ""
          }`}
        >
          {!selectedAvailable && (
            <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
          )}
          <span className="max-w-[140px] truncate">
            {selected?.label ?? "Model"}
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
        {GROUPS.map((group, groupIndex) => {
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
                  const available = isModelAvailable(model.id, keyStatus);
                  return (
                    <DropdownItem
                      key={model.id}
                      onSelect={() => onChange(model.id)}
                      selected={model.id === value}
                      className="ml-2 py-1.5 text-sm text-gray-700 data-[highlighted]:text-gray-900"
                    >
                      <span
                        className={`flex-1 ${available ? "" : "text-gray-400"}`}
                      >
                        {model.label}
                      </span>
                      {!available ? (
                        <AlertCircle className="ml-1 h-3.5 w-3.5 text-red-500" />
                      ) : model.id === value ? (
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
