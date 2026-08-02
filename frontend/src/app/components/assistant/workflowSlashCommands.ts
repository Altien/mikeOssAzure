import type { Workflow } from "../shared/types";

export function slashCommandQuery(value: string): string | null {
    const trimmed = value.trim();
    if (!/^\/\S*$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

export function matchingSlashWorkflows(
    workflows: Workflow[],
    query: string | null,
): Workflow[] {
    if (query === null) return [];
    return workflows.filter((workflow) =>
        workflow.metadata.slash_trigger?.startsWith(query),
    );
}

export function exactSlashWorkflow(
    workflows: Workflow[],
    query: string,
): Workflow | undefined {
    const normalized = query.toLowerCase();
    return workflows.find(
        (workflow) => workflow.metadata.slash_trigger === normalized,
    );
}
