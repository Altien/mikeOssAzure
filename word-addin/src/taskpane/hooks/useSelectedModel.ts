import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiKeyStatus } from "../api/client";
import {
  ROUTER_SLUGS,
  canonicalModelId,
  isAllowedModelId,
  isModelAvailable,
} from "../lib/modelCatalog";

interface SelectedModelSources {
  sessionKey: number;
  chatModel?: string | null;
  lastUsedModel?: string | null;
  routerSelections?: {
    openRouterModels: string[];
    vercelModels: string[];
    openCodeGoModels: string[];
  } | null;
  /** Null means the key-status request failed and availability fails open. */
  apiKeyStatus: ApiKeyStatus | null;
}

function usableStoredModel(
  value: string | null | undefined,
  sources: SelectedModelSources,
): string | null {
  if (!value) return null;
  const model = canonicalModelId(value);
  if (!isAllowedModelId(model)) return null;
  const router = ROUTER_SLUGS.find((slug) => model.startsWith(`${slug}/`));
  if (router && sources.routerSelections) {
    const selections = {
      openrouter: sources.routerSelections.openRouterModels,
      vercel: sources.routerSelections.vercelModels,
      "opencode-go": sources.routerSelections.openCodeGoModels,
    };
    if (!selections[router].includes(model.slice(router.length + 1))) {
      return null;
    }
  }
  return isModelAvailable(model, sources.apiKeyStatus) ? model : null;
}

/** Resolve the saved chat model first, then the profile's shared last-used. */
export function useSelectedModel(
  sources: SelectedModelSources,
): [string, (model: string) => void] {
  const [model, setModelState] = useState("");
  const manualSelection = useRef(false);
  const previousSessionKey = useRef(sources.sessionKey);
  const openRouterModels = sources.routerSelections?.openRouterModels;
  const vercelModels = sources.routerSelections?.vercelModels;
  const openCodeGoModels = sources.routerSelections?.openCodeGoModels;

  useEffect(() => {
    if (previousSessionKey.current !== sources.sessionKey) {
      previousSessionKey.current = sources.sessionKey;
      manualSelection.current = false;
    }
    if (manualSelection.current) return;
    const next =
      usableStoredModel(sources.chatModel, sources) ??
      usableStoredModel(sources.lastUsedModel, sources) ??
      "";
    setModelState(next);
  }, [
    sources.sessionKey,
    sources.chatModel,
    sources.lastUsedModel,
    sources.apiKeyStatus,
    openRouterModels,
    vercelModels,
    openCodeGoModels,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModel = useCallback((raw: string): void => {
    const next = canonicalModelId(raw);
    manualSelection.current = true;
    setModelState(isAllowedModelId(next) ? next : "");
  }, []);
  return [model, setModel];
}
