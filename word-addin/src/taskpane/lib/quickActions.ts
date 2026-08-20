import type { QuickAction } from "../types";

export function quickActionDisplayName(
  action: Pick<QuickAction, "name" | "workflow">,
): string {
  return action.name?.trim() || action.workflow.title;
}

export function isWordQuickActionWorkflow(
  workflow: { default_key?: string | null; metadata: { title: string } },
): boolean {
  if (workflow.default_key) return workflow.default_key !== "compare-documents";
  return workflow.metadata.title.trim().toLowerCase() !== "compare documents";
}
