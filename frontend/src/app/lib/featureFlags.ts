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
export type UserFeatureFlags = Record<UserFeatureKey, boolean>;

export const DEPLOYMENT_MODULE_KEYS = [
    ...USER_FEATURE_KEYS,
    "gmail",
] as const;
export type DeploymentModuleKey = (typeof DEPLOYMENT_MODULE_KEYS)[number];
export type DeploymentModules = Record<DeploymentModuleKey, boolean>;

export const DEFAULT_DEPLOYMENT_MODULES: DeploymentModules =
    Object.fromEntries(
        DEPLOYMENT_MODULE_KEYS.map((key) => [key, true]),
    ) as DeploymentModules;

export const DEFAULT_USER_FEATURE_FLAGS: UserFeatureFlags = Object.fromEntries(
    USER_FEATURE_KEYS.map((key) => [key, true]),
) as UserFeatureFlags;

export const USER_FEATURE_CATALOG: Array<{
    key: UserFeatureKey;
    name: string;
    description: string;
    group: "Workspace" | "Integrations" | "Models";
}> = [
    {
        key: "promptLibrary",
        name: "Prompt Library",
        description: "Save, organise, and reuse legal prompts.",
        group: "Workspace",
    },
    {
        key: "legalMonitors",
        name: "Monitoring",
        description: "Create scheduled alerts across feeds, documents, and configured connectors.",
        group: "Workspace",
    },
    {
        key: "playbooks",
        name: "Playbooks",
        description: "Import Word playbooks and use them for document reviews.",
        group: "Workspace",
    },
    {
        key: "ironclad",
        name: "Ironclad",
        description: "Search and import contracts from Ironclad.",
        group: "Integrations",
    },
    {
        key: "patentConnector",
        name: "USPTO Patent Connector",
        description: "Provision and use the managed local patent MCP connector.",
        group: "Integrations",
    },
    {
        key: "localModels",
        name: "Local Models",
        description: "Make configured local OpenAI-compatible models available.",
        group: "Models",
    },
    {
        key: "committeeModels",
        name: "Committee Models",
        description: "Make multi-model committee orchestration available.",
        group: "Models",
    },
];

export function featureEnabled(
    flags: Partial<UserFeatureFlags> | null | undefined,
    key: UserFeatureKey,
    modules?: Partial<DeploymentModules> | null,
): boolean {
    return modules?.[key] !== false && flags?.[key] !== false;
}

export function deploymentModuleEnabled(
    modules: Partial<DeploymentModules> | null | undefined,
    key: DeploymentModuleKey,
): boolean {
    return modules?.[key] !== false;
}
