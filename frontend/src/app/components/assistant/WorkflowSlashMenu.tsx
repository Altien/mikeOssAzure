"use client";

import { useEffect, useRef } from "react";
import type { Workflow } from "../shared/types";
import { workflowSlashCommand } from "./workflowSlashCommands";

export const WORKFLOW_SLASH_MENU_ID = "workflow-slash-menu";

interface Props {
    workflows: Workflow[];
    activeIndex: number;
    onSelect: (workflow: Workflow) => void;
}

export function WorkflowSlashMenu({ workflows, activeIndex, onSelect }: Props) {
    const activeOptionRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [activeIndex]);

    if (workflows.length === 0) return null;

    return (
        <div
            id={WORKFLOW_SLASH_MENU_ID}
            role="listbox"
            aria-label="Workflow commands"
            className="absolute bottom-full left-0 mb-1.5 grid max-h-64 w-full gap-1 overflow-y-auto rounded-[18px] border border-white/65 bg-white/60 p-1 shadow-[0_4px_10px_rgba(15,23,42,0.084),inset_0_1px_0_rgba(255,255,255,0.595),inset_0_-6px_14px_rgba(255,255,255,0.126)] backdrop-blur-2xl overscroll-contain md:rounded-[22px]"
        >
            {workflows.map((workflow, index) => {
                const trigger = workflowSlashCommand(workflow);
                if (!trigger) return null;
                const active = index === activeIndex;
                return (
                    <button
                        ref={active ? activeOptionRef : undefined}
                        key={workflow.id}
                        id={`${WORKFLOW_SLASH_MENU_ID}-${index}`}
                        type="button"
                        role="option"
                        aria-label={`${trigger} ${workflow.metadata.title}`}
                        aria-selected={active}
                        onClick={() => onSelect(workflow)}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                            active
                                ? "bg-gray-100/90 text-gray-900"
                                : "text-gray-700 hover:bg-gray-100/70"
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
