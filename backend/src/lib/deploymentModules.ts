import type { RequestHandler } from "express";

export const DEPLOYMENT_MODULE_KEYS = [
  "promptLibrary",
  "legalMonitors",
  "playbooks",
  "ironclad",
  "gmail",
  "localModels",
  "committeeModels",
  "patentConnector",
] as const;

export type DeploymentModuleKey = (typeof DEPLOYMENT_MODULE_KEYS)[number];
export type DeploymentModules = Record<DeploymentModuleKey, boolean>;

const MODULE_BY_NORMALIZED_NAME = new Map(
  DEPLOYMENT_MODULE_KEYS.map((key) => [key.toLowerCase(), key]),
);

/**
 * Resolves which packaged optional modules this deployment exposes.
 *
 * MIKE_ENABLED_MODULES accepts `all`, `none`, or a comma-separated list of
 * canonical module keys. Omitting it preserves the pre-registry behavior in
 * which every packaged module is available.
 */
export function resolveDeploymentModules(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentModules {
  const configured = env.MIKE_ENABLED_MODULES?.trim();
  const enabled = new Set<DeploymentModuleKey>();

  if (!configured || configured.toLowerCase() === "all") {
    for (const key of DEPLOYMENT_MODULE_KEYS) enabled.add(key);
  } else if (configured.toLowerCase() !== "none") {
    for (const token of configured.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (!normalized) continue;
      const key = MODULE_BY_NORMALIZED_NAME.get(normalized);
      if (!key) {
        throw new Error(
          `Unsupported module "${token.trim()}" in MIKE_ENABLED_MODULES. Expected all, none, or: ${DEPLOYMENT_MODULE_KEYS.join(", ")}.`,
        );
      }
      enabled.add(key);
    }
  }

  return Object.fromEntries(
    DEPLOYMENT_MODULE_KEYS.map((key) => [key, enabled.has(key)]),
  ) as DeploymentModules;
}

export function deploymentModuleEnabled(
  key: DeploymentModuleKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveDeploymentModules(env)[key];
}

export function requireDeploymentModule(
  key: DeploymentModuleKey,
): RequestHandler {
  return (_req, res, next) => {
    if (!deploymentModuleEnabled(key)) {
      res.status(404).json({
        detail: "This optional module is not enabled for this Mike deployment.",
        code: "module_unavailable",
        module: key,
      });
      return;
    }
    next();
  };
}
