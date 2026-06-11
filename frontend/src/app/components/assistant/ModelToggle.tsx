"use client";

import { useState } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    isModelAvailable,
    type ApiKeyAvailability,
} from "@/app/lib/modelAvailability";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "Azure OpenAI";
}

export const MODELS: ModelOption[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    // Azure OpenAI entries are appended dynamically at render time from
    // deployment discovery — see UserProfileContext.aoaiDeployments.
];

export const SETTINGS_MODELS: ModelOption[] = [
    ...MODELS,
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    {
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash Lite",
        group: "Google",
    },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

const STATIC_ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

// Validates a model id from user input or storage. Static models live
// in the set above; AOAI deployments are accepted by prefix because
// the deployment names are user-defined and only known at runtime.
export function isAllowedModelId(id: string): boolean {
    return STATIC_ALLOWED_MODEL_IDS.has(id) || id.startsWith("aoai:");
}

// Backwards-compat alias for the few callers that previously did
// `ALLOWED_MODEL_IDS.has(id)`. New code should use `isAllowedModelId`.
export const ALLOWED_MODEL_IDS = {
    has: (id: string) => isAllowedModelId(id),
};

const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
    "Azure OpenAI",
];

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyAvailability;
    // Extra entries to merge into the static MODELS list. Today this
    // carries Azure OpenAI deployments discovered against a configured
    // endpoint; the same hook can be used for any other dynamically-
    // sourced provider in future. Entries here are always considered
    // available (they wouldn't have come back from discovery otherwise).
    extraModels?: ModelOption[];
}

export function ModelToggle({ value, onChange, apiKeys, extraModels }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const allModels = extraModels ? [...MODELS, ...extraModels] : MODELS;
    const selected = allModels.find((m) => m.id === value);
    const selectedLabel = selected?.label ?? "Model";
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys, extraModels)
        : true;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-700 ${isOpen ? "bg-gray-100 text-gray-700" : ""}`}
                    title={
                        !selectedAvailable
                            ? "API key missing for selected model"
                            : "Choose model"
                    }
                >
                    {!selectedAvailable && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    <span className="max-w-[140px] truncate">{selectedLabel}</span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 z-50" side="top" align="end">
                {GROUP_ORDER.map((group, gi) => {
                    const items = allModels.filter((m) => m.group === group);
                    // Azure OpenAI is special-cased: render its section
                    // header + a disabled placeholder when there are no
                    // deployments yet (discovery hasn't run / global key
                    // unset / no deployments returned). Without this, AOAI
                    // is INVISIBLE even when configured, so the operator
                    // has no on-screen confirmation it took effect.
                    // Closes 040 Entry 13 fix A.
                    if (items.length === 0) {
                        if (group !== "Azure OpenAI") return null;
                        return (
                            <div key={group}>
                                {gi > 0 && <DropdownMenuSeparator />}
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                    {group}
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                    disabled
                                    className="cursor-default"
                                >
                                    <span className="flex-1 text-gray-400 italic">
                                        {apiKeys?.globalApiKeys?.azureOpenai
                                            ? "Discovering deployments…"
                                            : "Configure in /install to use"}
                                    </span>
                                </DropdownMenuItem>
                            </div>
                        );
                    }
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys, extraModels)
                                    : true;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle
                                                className="h-3.5 w-3.5 text-red-500 ml-1"
                                                aria-label="API key missing"
                                            />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
