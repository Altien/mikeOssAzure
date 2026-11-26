import { getConfig } from "./config";

export type TenancyMode = "single" | "pooled";
let frozenMode: TenancyMode | undefined;

/** Startup freezes the mode only after the database agrees. Changes require redeploy. */
export function freezeTenancyMode(mode: TenancyMode): void {
  if (frozenMode && frozenMode !== mode) throw new Error("Tenancy mode is already frozen");
  frozenMode = mode;
}

export function resetFrozenTenancyModeForTests(): void { frozenMode = undefined; }

/** Missing config preserves existing installs; operational failures never select single. */
export async function getTenancyMode(): Promise<TenancyMode> {
  if (frozenMode) return frozenMode;
  let value: string;
  try {
    value = !process.env.TENANCY_MODE && !process.env.KEY_VAULT_NAME ? "single" : await getConfig("tenancy-mode");
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    value = "single";
  }
  const mode = value?.trim().toLowerCase() || "single";
  if (mode !== "single" && mode !== "pooled") throw new Error("Invalid tenancy mode");
  return mode;
}
