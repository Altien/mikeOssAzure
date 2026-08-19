"use client";

import { useState } from "react";
import { ChevronDown, Check, Settings2 } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";

export interface ModelOption {
    id: string;
    label: string;
    group:
        | "Anthropic"
        | "Google"
        | "OpenAI"
        | "OpenRouter"
        | "Vercel AI Gateway"
        | "Local";
}

export const MODELS: ModelOption[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", group: "Google" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", group: "Google" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "OpenAI" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    // Local (Ollama) models are appended dynamically — see useOllamaModels.
];

export const SETTINGS_MODELS: ModelOption[] = [
    ...MODELS,
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite",
        group: "Google",
    },
    {
        id: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash-Lite",
        group: "Google",
    },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const MODEL_NAME_ACRONYMS: Record<string, string> = {
    ai: "AI",
    gpt: "GPT",
    oss: "OSS",
    r1: "R1",
};

export function modelDisplayName(modelId: string): string {
    const normalized = modelId
        .replace(/^(?:openrouter|vercel|ollama)\//, "")
        .split("/")
        .at(-1)!
        .replace(/(\d)-(\d)/g, "$1.$2");
    const [rawName, variant] = normalized.split(":", 2);
    const name = rawName ?? normalized;
    const label = name
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((token) => {
            const lower = token.toLowerCase();
            if (MODEL_NAME_ACRONYMS[lower]) {
                return MODEL_NAME_ACRONYMS[lower];
            }
            if (/^\d+[bk]$/i.test(token)) return token.toUpperCase();
            return token.charAt(0).toUpperCase() + token.slice(1);
        })
        .join(" ");
    if (!variant) return label;
    const variantLabel = variant
        .split(/[-_]+/)
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
        .join(" ");
    return `${label} (${variantLabel})`;
}

const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
    "OpenRouter",
    "Vercel AI Gateway",
    "Local",
];
const itemClassName =
    "rounded-xl px-2.5 py-1.5 text-gray-700 focus:bg-app-surface-hover focus:text-gray-900 data-[highlighted]:bg-app-surface-hover data-[highlighted]:text-gray-900";

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    openRouterModels?: string[];
    vercelModels?: string[];
    compact?: boolean;
}

export function openRouterModelOptions(models: string[]): ModelOption[] {
    return models.map((model) => ({
        id: `openrouter/${model}`,
        label: modelDisplayName(model),
        group: "OpenRouter",
    }));
}

export function vercelModelOptions(models: string[]): ModelOption[] {
    return models.map((model) => ({
        id: `vercel/${model}`,
        label: modelDisplayName(model),
        group: "Vercel AI Gateway",
    }));
}

export function ModelToggle({
    value,
    onChange,
    apiKeys,
    openRouterModels = [],
    vercelModels = [],
    compact = false,
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [expandedGroup, setExpandedGroup] = useState<
        ModelOption["group"] | null
    >(null);
    const ollamaModels = useOllamaModels();
    const models = [
        ...MODELS,
        ...openRouterModelOptions(openRouterModels),
        ...vercelModelOptions(vercelModels),
        ...ollamaModels.map((model) => ({
            ...model,
            label: modelDisplayName(model.id),
        })),
    ];
    const availableModels = models.filter((model) => {
        if (model.group === "Local") return true;
        return apiKeys ? isModelAvailable(model.id, apiKeys) : false;
    });
    const selected = availableModels.find((model) => model.id === value);
    const selectedLabel =
        selected?.label ??
        (availableModels.length > 0 ? "Select model" : "No API Key");
    const availableGroups = GROUP_ORDER.flatMap((group) => {
        const items = availableModels.filter((model) => model.group === group);
        return items.length ? [{ group, items }] : [];
    });

    const handleOpenChange = (open: boolean) => {
        setIsOpen(open);
        if (open) {
            setExpandedGroup(
                selected?.group ??
                    (value.startsWith("ollama/") ? "Local" : null) ??
                    GROUP_ORDER.find((group) =>
                        availableModels.some((model) => model.group === group),
                    ) ??
                    null,
            );
        }
    };

    return (
        <DropdownMenu onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Choose model"
                    disabled={availableModels.length === 0}
                    className={`flex h-8 items-center rounded-full text-sm text-gray-400 transition-colors enabled:cursor-pointer enabled:hover:text-gray-700 disabled:cursor-default ${compact ? "w-8 justify-center px-0" : "gap-1.5 px-2"} ${isOpen ? "text-gray-700" : ""}`}
                    title={
                        availableModels.length
                            ? "Choose model"
                            : "No API key configured"
                    }
                >
                    {compact ? (
                        <Settings2 className="h-4 w-4 shrink-0" />
                    ) : (
                        <>
                            <span className="max-w-[200px] truncate">
                                {selectedLabel}
                            </span>
                            <ChevronDown
                                className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                            />
                        </>
                    )}
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50 w-56 p-1.5 text-gray-700"
                side="top"
                align="end"
            >
                {availableGroups.map(({ group, items }, groupIndex) => {
                    const expanded = expandedGroup === group;
                    return (
                        <div key={group}>
                            {groupIndex > 0 && (
                                <DropdownMenuSeparator className="-mx-1 my-1 bg-white/70" />
                            )}
                            <LiquidDropdownItem
                                aria-expanded={expanded}
                                className="rounded-xl px-2.5 py-2 font-medium text-gray-700 focus:bg-app-surface-hover focus:text-gray-900 data-[highlighted]:bg-app-surface-hover data-[highlighted]:text-gray-900"
                                onSelect={(event) => {
                                    event.preventDefault();
                                    setExpandedGroup(expanded ? null : group);
                                }}
                            >
                                <span className="flex-1">{group}</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 text-gray-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                                />
                            </LiquidDropdownItem>
                            {expanded &&
                                items.map((m) => {
                                    return (
                                        <LiquidDropdownItem
                                            key={m.id}
                                            className={`${itemClassName} ${m.id === value ? "bg-app-surface-hover text-gray-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]" : ""}`}
                                            onSelect={() => onChange(m.id)}
                                        >
                                            <span className="flex-1">
                                                {m.label}
                                            </span>
                                            {m.id === value && (
                                                <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                                            )}
                                        </LiquidDropdownItem>
                                    );
                                })}
                        </div>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
