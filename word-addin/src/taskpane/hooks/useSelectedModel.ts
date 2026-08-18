import { useCallback, useState } from "react";
import {
  DEFAULT_MODEL_ID,
  canonicalModelId,
  isAllowedModelId,
} from "../lib/modelCatalog";

const STORAGE_KEY = "mike.selectedModel";
// Substituted at bundle time; a `typeof process` guard is false in the browser
// and would silently pin the fallback instead of the configured model.
const CONFIGURED_DEFAULT_MODEL = process.env.REACT_APP_DEFAULT_MODEL || "";
const DEFAULT_MODEL = isAllowedModelId(CONFIGURED_DEFAULT_MODEL)
  ? CONFIGURED_DEFAULT_MODEL
  : DEFAULT_MODEL_ID;

function readStoredModel(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Map renamed static ids to their current equivalents before validating,
    // so a selection stored before a catalog rename keeps working — matching
    // the web composer, which reads the same storage key.
    const stored = raw ? canonicalModelId(raw) : null;
    return stored && isAllowedModelId(stored) ? stored : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function useSelectedModel(): [string, (model: string) => void] {
  const [model, setModelState] = useState(readStoredModel);
  const setModel = useCallback((raw: string): void => {
    const next = canonicalModelId(raw);
    const validated = isAllowedModelId(next) ? next : DEFAULT_MODEL;
    setModelState(validated);
    try {
      window.localStorage.setItem(STORAGE_KEY, validated);
    } catch {
      // A private/locked-down Office webview can reject localStorage writes;
      // the selection still applies for the current pane session.
    }
  }, []);
  return [model, setModel];
}
