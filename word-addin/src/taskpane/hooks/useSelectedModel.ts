import { ROUTER_SLUGS } from "@mike/model-catalog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiKeyStatus } from "../api/client";
import {
  canonicalModelId,
  isAllowedModelId,
  isRouterModelSelected,
  type RouterSelections,
} from "@mike/model-catalog";
import { isModelAvailable } from "../lib/modelCatalog";

interface SelectedModelSources {
  sessionKey: number;
  chatModel?: string | null;
  lastSelectedModel?: string | null;
  routerSelections?: RouterSelections | null;
  /** Null means the key-status request failed and availability fails open. */
  apiKeyStatus: ApiKeyStatus | null;
  configuredModelIds?: readonly string[];
}

function usableStoredModel(
  value: string | null | undefined,
  sources: SelectedModelSources,
): string | null {
  if (!value) return null;
  const model = sources.configuredModelIds?.includes(value) ? value : canonicalModelId(value);
  if (!isAllowedModelId(model, sources.configuredModelIds)) return null;
  const router = ROUTER_SLUGS.find((slug) => model.startsWith(`${slug}/`));
  if (router && !sources.configuredModelIds?.includes(model) && sources.routerSelections) {
    const selection = sources.routerSelections[router] ?? [];
    if (!selection.includes(model.slice(router.length + 1))) return null;
  }
  return isModelAvailable(model, sources.apiKeyStatus, sources.configuredModelIds) ? model : null;
}

/** Resolve the saved chat model first, then the profile's shared last-selected. */
export function useSelectedModel(
  sources: SelectedModelSources,
): [string, (model: string) => void, boolean] {
  const [model, setModelState] = useState("");
  const [settingsResolved, setSettingsResolved] = useState(
    sources.chatModel !== undefined,
  );
  const manualSelection = useRef(false);
  const previousSessionKey = useRef(sources.sessionKey);
  const routerSelectionsKey = sources.routerSelections ? JSON.stringify(sources.routerSelections) : null;

  useEffect(() => {
    if (previousSessionKey.current !== sources.sessionKey) {
      previousSessionKey.current = sources.sessionKey;
      manualSelection.current = false;
    }
    if (manualSelection.current) return;
    if (sources.chatModel === undefined) {
      // Existing chat settings have not loaded yet. Do not flash the shared
      // profile fallback before the chat's own model arrives.
      setModelState("");
      setSettingsResolved(false);
      return;
    }
    const next =
      usableStoredModel(sources.chatModel, sources) ??
      usableStoredModel(sources.lastSelectedModel, sources) ??
      "";
    setModelState(next);
    setSettingsResolved(true);
  }, [
    sources.sessionKey,
    sources.chatModel,
    sources.lastSelectedModel,
    sources.apiKeyStatus,
    routerSelectionsKey,
    sources.configuredModelIds,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModel = useCallback((raw: string): void => {
    const next = sources.configuredModelIds?.includes(raw) ? raw : canonicalModelId(raw);
    manualSelection.current = true;
    setModelState(isAllowedModelId(next, sources.configuredModelIds) ? next : "");
    setSettingsResolved(true);
  }, [sources.configuredModelIds]);
  return [model, setModel, settingsResolved];
}
