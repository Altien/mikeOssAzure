// Manifest model for the install configurator (issue 023 §"Manifest model").
//
// The manifest is the source of truth for "what does this deployment need
// to be operationally complete." Each item knows how to verify itself
// (`check`) and how the operator fixes it when the check fails (`fixedBy`).

export type ManifestSection =
    | "Foundations"
    | "AI providers"
    | "Entra ID"
    | "Tenant policy"
    | "Lifecycle"
    | "Optional";

export type FormField = {
    name: string;
    label: string;
    type: "text" | "password" | "url";
    placeholder?: string;
    pattern?: string;
    required?: boolean;
    /** When set, renders a <select> with these values instead of <input>. */
    options?: string[];
    /** Explanatory paragraph rendered below the input. */
    helpText?: string;
};

/**
 * One operator-tweakable choice in a script command (region, model, …).
 * The renderer turns these into <select> dropdowns next to the command;
 * picking a value rewrites the displayed command + clipboard payload
 * live, so the operator can confirm the line before they paste.
 */
export type TweakOption = {
    /** Matches a `<name>` placeholder in the argsTemplate. */
    name: string;
    label: string;
    options: string[];
    defaultValue: string;
};

/**
 * Optional secondary path for an in-app-form item: the same item can be
 * fixed by a downloadable script too (typically when the script does
 * something the form can't, like provisioning a fresh Azure resource).
 */
export type AlsoAsScript = {
    scriptName: string;
    argsTemplate: string;
    description: string;
    /** Operator-pickable options that get substituted into argsTemplate. */
    tweakOptions?: TweakOption[];
};

export type FixedBy =
    | {
          type: "in-app-form";
          submitTo: "kv";
          fields: FormField[];
          alsoAsScript?: AlsoAsScript;
      }
    | { type: "external-script"; scriptName: string; argsTemplate: string }
    | { type: "auto"; description: string };

export type CheckResult = {
    status: "pass" | "fail" | "info";
    detail?: string;
};

// Context shared by every check + by the script-args renderer. Grows as
// later slices need more handles (Graph access, Container App
// self-introspection, etc.).
export type InstallContext = {
    backendFqdn: string;
    keyVaultName: string;
    resourceGroup: string;
    // When set (via the `custom-backend-fqdn` KV secret edited from /install),
    // overrides backendFqdn in script command-line `<fqdn>` substitution so
    // operators can register a custom domain (e.g. mike.altien.com) on the
    // Entra app reg without changing how they reach /install itself.
    customFqdn?: string;
};

export type ManifestItem = {
    id: string;
    label: string;
    section: ManifestSection;
    required: boolean;
    requires?: string[];
    check: (ctx: InstallContext) => Promise<CheckResult>;
    fixedBy: FixedBy;
    requiresRevisionRestart?: boolean;
    /**
     * When true, the row is rendered de-emphasized — the fix path is
     * intended for power users / OSS deployments rather than the
     * marketplace happy path. The check still runs and the row still
     * shows its status; only the "how to fix" UX is collapsed. See
     * 036a Phase 6 (B6 — "hide, don't delete" interpretation).
     */
    advanced?: boolean;
};

export type EvaluatedItem = ManifestItem & {
    result: CheckResult;
    canAct: boolean;
};
