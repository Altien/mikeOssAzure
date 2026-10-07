"use client";

import { ChevronDown } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";

export interface SelectionAction {
    label: string;
    onSelect: () => void;
    destructive?: boolean;
    disabled?: boolean;
}

/**
 * The toolbar "Actions" menu a table shows while rows are selected. Pass
 * `open` and `onOpenChange` only when the page needs to close it itself.
 */
export function SelectionActionsMenu({
    actions,
    open,
    onOpenChange,
    className,
}: {
    actions: SelectionAction[];
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Applied to the trigger, for responsive visibility. */
    className?: string;
}) {
    return (
        <Dropdown open={open} onOpenChange={onOpenChange}>
            <DropdownTrigger asChild>
                <TabPillButtonUI className={className}>
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButtonUI>
            </DropdownTrigger>
            <DropdownContent align="end" className="w-36">
                {actions.map((action) => (
                    <DropdownItem
                        key={action.label}
                        variant={action.destructive ? "destructive" : "default"}
                        disabled={action.disabled}
                        onSelect={action.onSelect}
                    >
                        {action.label}
                    </DropdownItem>
                ))}
            </DropdownContent>
        </Dropdown>
    );
}
