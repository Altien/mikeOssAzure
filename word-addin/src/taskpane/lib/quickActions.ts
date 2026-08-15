import type { QuickAction } from "../types";

export function quickActionDisplayName(
  action: Pick<QuickAction, "name" | "workflow">,
): string {
  return action.name?.trim() || action.workflow.title;
}
