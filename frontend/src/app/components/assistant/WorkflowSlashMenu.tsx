import type { Workflow } from "../shared/types";

export const WORKFLOW_SLASH_MENU_ID = "workflow-slash-menu";

interface Props {
    workflows: Workflow[];
    activeIndex: number;
    loading: boolean;
    onActiveIndexChange: (index: number) => void;
    onSelect: (workflow: Workflow) => void;
}

export function WorkflowSlashMenu({
    workflows,
    activeIndex,
    loading,
    onActiveIndexChange,
    onSelect,
}: Props) {
    if (loading) {
        return (
            <div
                id={WORKFLOW_SLASH_MENU_ID}
                role="status"
                className="absolute bottom-full left-0 mb-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg"
            >
                Loading commands...
            </div>
        );
    }

    if (workflows.length === 0) return null;

    return (
        <div
            id={WORKFLOW_SLASH_MENU_ID}
            role="listbox"
            aria-label="Workflow commands"
            className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-xl border border-gray-200 bg-white p-1 shadow-lg"
        >
            {workflows.map((workflow, index) => {
                const trigger = workflow.metadata.slash_trigger!;
                const active = index === activeIndex;
                return (
                    <button
                        key={workflow.id}
                        id={`${WORKFLOW_SLASH_MENU_ID}-${index}`}
                        type="button"
                        role="option"
                        aria-label={`${trigger} ${workflow.metadata.title}`}
                        aria-selected={active}
                        onMouseEnter={() => onActiveIndexChange(index)}
                        onClick={() => onSelect(workflow)}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                            active ? "bg-gray-100" : "hover:bg-gray-50"
                        }`}
                    >
                        <span className="font-medium text-gray-900">
                            {trigger}
                        </span>
                        <span className="truncate text-gray-500">
                            {workflow.metadata.title}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
