"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    canonicalModelId,
    ROUTER_SLUGS,
    type RouterSlug,
} from "../components/assistant/ModelToggle";
import { isModelAvailable } from "../lib/modelAvailability";
import type { ApiKeyState } from "../lib/mikeApi";

/**
 * The composer's accepted-id surface. Exported so the Word add-in drift guard
 * (frontend/src/wordAddin/catalogParity.test.ts) can compare it against the
 * add-in's hand-mirrored copy instead of restating the rule.
 */
export function isAllowedModelId(id: string): boolean {
    return (
        ALLOWED_MODEL_IDS.has(id) ||
        id.startsWith("ollama/") ||
        ROUTER_SLUGS.some((slug) => id.startsWith(`${slug}/`))
    );
}

export interface SelectedModelSources {
    selectionKey?: string | null;
    chatModel?: string | null;
    lastUsedModel?: string | null;
    routerSelections?: {
        openRouterModels: string[];
        vercelModels: string[];
        openCodeGoModels: string[];
    } | null;
    /** Undefined means availability is unknown and must fail open. */
    apiKeys?: ApiKeyState;
}

function usableStoredModel(
    value: string | null | undefined,
    sources: SelectedModelSources,
): string | null {
    if (!value) return null;
    const canonical = canonicalModelId(value);
    if (!isAllowedModelId(canonical)) return null;

    const router = ROUTER_SLUGS.find((slug) =>
        canonical.startsWith(`${slug}/`),
    );
    if (router && sources.routerSelections) {
        const selections: Record<RouterSlug, string[]> = {
            openrouter: sources.routerSelections.openRouterModels,
            vercel: sources.routerSelections.vercelModels,
            "opencode-go": sources.routerSelections.openCodeGoModels,
        };
        if (!selections[router].includes(canonical.slice(router.length + 1))) {
            return null;
        }
    }
    if (sources.apiKeys && !isModelAvailable(canonical, sources.apiKeys)) {
        return null;
    }
    return canonical;
}

/** Resolve chat model → profile last-used model, without a product default. */
export function useSelectedModel(
    sources: SelectedModelSources = {},
): [string, (id: string) => void] {
    const [model, setModelState] = useState("");
    const manuallySelected = useRef(false);
    const previousSelectionKey = useRef(sources.selectionKey);
    const openRouterModels = sources.routerSelections?.openRouterModels;
    const vercelModels = sources.routerSelections?.vercelModels;
    const openCodeGoModels = sources.routerSelections?.openCodeGoModels;
    const hasRouterSelections = sources.routerSelections != null;
    const selectionSources = useMemo<SelectedModelSources>(
        () => ({
            selectionKey: sources.selectionKey,
            chatModel: sources.chatModel,
            lastUsedModel: sources.lastUsedModel,
            routerSelections: hasRouterSelections
                ? {
                      openRouterModels: openRouterModels ?? [],
                      vercelModels: vercelModels ?? [],
                      openCodeGoModels: openCodeGoModels ?? [],
                  }
                : null,
            apiKeys: sources.apiKeys,
        }),
        [
            sources.selectionKey,
            sources.chatModel,
            sources.lastUsedModel,
            hasRouterSelections,
            openRouterModels,
            vercelModels,
            openCodeGoModels,
            sources.apiKeys,
        ],
    );

    useEffect(() => {
        if (previousSelectionKey.current !== selectionSources.selectionKey) {
            previousSelectionKey.current = selectionSources.selectionKey;
            manuallySelected.current = false;
        }
        if (manuallySelected.current) return;
        const next =
            usableStoredModel(selectionSources.chatModel, selectionSources) ??
            usableStoredModel(
                selectionSources.lastUsedModel,
                selectionSources,
            ) ??
            "";
        // eslint-disable-next-line react-hooks/set-state-in-effect -- profile/chat data arrives asynchronously and determines the initial composer selection
        setModelState(next);
    }, [selectionSources]);

    const setModel = useCallback((id: string) => {
        const canonical = canonicalModelId(id);
        const next = isAllowedModelId(canonical) ? canonical : "";
        manuallySelected.current = true;
        setModelState(next);
    }, []);

    return [model, setModel];
}
