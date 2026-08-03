import type { Workflow } from "../shared/types";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { APP_SURFACE_ACTIVE_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { workflowSlashCommand } from "./workflowSlashCommands";

export const WORKFLOW_SLASH_MENU_ID = "workflow-slash-menu";

interface Props {
    workflows: Workflow[];
    activeIndex: number;
    onActiveIndexChange: (index: number) => void;
    onSelect: (workflow: Workflow) => void;
}

export function WorkflowSlashMenu({
    workflows,
    activeIndex,
    onActiveIndexChange,
    onSelect,
}: Props) {
    if (workflows.length === 0) return null;

    return (
        <LiquidDropdownSurface
            id={WORKFLOW_SLASH_MENU_ID}
            role="listbox"
            aria-label="Workflow commands"
            className="absolute bottom-full left-0 mb-2 w-full overflow-hidden p-1"
        >
            {workflows.map((workflow, index) => {
                const trigger = workflowSlashCommand(workflow);
                if (!trigger) return null;
                const active = index === activeIndex;
                return (
                    <LiquidDropdownButton
                        key={workflow.id}
                        id={`${WORKFLOW_SLASH_MENU_ID}-${index}`}
                        role="option"
                        aria-label={`${trigger} ${workflow.metadata.title}`}
                        aria-selected={active}
                        onMouseEnter={() => onActiveIndexChange(index)}
                        onClick={() => onSelect(workflow)}
                        className={cn(
                            "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm",
                            active && APP_SURFACE_ACTIVE_CLASS,
                        )}
                    >
                        <span className="font-medium text-gray-900">
                            {trigger}
                        </span>
                        <span className="truncate text-gray-500">
                            {workflow.metadata.title}
                        </span>
                    </LiquidDropdownButton>
                );
            })}
        </LiquidDropdownSurface>
    );
}
