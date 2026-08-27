import type { RequestHandler } from "express";
import { createServerDatabase, type ServerDatabase } from "./database";
import { getCommitteeModel, getConfiguredModel } from "./llm/registry";
import {
  deploymentModuleEnabled,
  type DeploymentModuleKey,
} from "./deploymentModules";

export const USER_FEATURE_KEYS = [
  "promptLibrary",
  "legalMonitors",
  "playbooks",
  "ironclad",
  "localModels",
  "committeeModels",
  "patentConnector",
] as const;

export type UserFeatureKey = (typeof USER_FEATURE_KEYS)[number];
export type UserFeatures = Record<UserFeatureKey, boolean>;

export const DEFAULT_USER_FEATURES: UserFeatures = Object.fromEntries(
  USER_FEATURE_KEYS.map((key) => [key, true]),
) as UserFeatures;

export function normalizeUserFeatures(value: unknown): UserFeatures {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      candidate = null;
    }
  }
  const record =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    USER_FEATURE_KEYS.map((key) => [
      key,
      typeof record[key] === "boolean" ? record[key] : true,
    ]),
  ) as UserFeatures;
}

export async function getUserFeatures(
  userId: string,
  db: ServerDatabase = createServerDatabase(),
): Promise<UserFeatures> {
  const { data, error } = await db
    .from("user_profiles")
    .select("feature_flags")
    .eq("user_id", userId)
    .maybeSingle();
  const configured =
    error || !data
      ? { ...DEFAULT_USER_FEATURES }
      : normalizeUserFeatures(
          (data as { feature_flags?: unknown }).feature_flags,
        );
  return Object.fromEntries(
    USER_FEATURE_KEYS.map((key) => [
      key,
      configured[key] && deploymentModuleEnabled(key as DeploymentModuleKey),
    ]),
  ) as UserFeatures;
}

export function requireUserFeature(key: UserFeatureKey): RequestHandler {
  return async (_req, res, next) => {
    if (!deploymentModuleEnabled(key)) {
      res.status(404).json({
        detail: "This optional module is not enabled for this Mike deployment.",
        code: "module_unavailable",
        module: key,
      });
      return;
    }
    const userId = res.locals.userId as string | undefined;
    if (!userId) {
      res.status(401).json({ detail: "Authentication required" });
      return;
    }
    const features = await getUserFeatures(userId);
    if (!features[key]) {
      res.status(403).json({
        detail: "This feature is disabled in Account > Features.",
        code: "feature_disabled",
        feature: key,
      });
      return;
    }
    next();
  };
}

export function featureForModel(
  model: string | null | undefined,
): "localModels" | "committeeModels" | null {
  if (!model) return null;
  if (getCommitteeModel(model)) return "committeeModels";
  if (getConfiguredModel(model)?.location === "local") return "localModels";
  return null;
}
