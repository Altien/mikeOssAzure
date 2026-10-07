"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
import { ROW_ACTION_MENU_CLASS } from "./RowActions";
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

function SelectionMenuContent({
    renderItems,
    onActionChosen,
}: {
    renderItems: (onActionChosen: () => void) => ReactNode;
    onActionChosen: () => void;
}) {
    return renderItems(onActionChosen);
}

/**
 * The toolbar "Actions" menu a table shows while rows are selected. Pass
 * `open` and `onOpenChange` only when the page needs to close it itself.
 */
export function SelectionActionsMenu({
    actions = [],
    children,
    renderItems,
    open,
    onOpenChange,
    className,
}: {
    actions?: SelectionAction[];
    children?: ReactNode;
    renderItems?: (onActionChosen: () => void) => ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Applied to the trigger, for responsive visibility. */
    className?: string;
}) {
    const actionChosenRef = useRef(false);
    return (
        <Dropdown
            open={open}
            onOpenChange={onOpenChange}
            modal={renderItems ? false : undefined}
        >
            <DropdownTrigger asChild>
                <TabPillButtonUI
                    data-icon-position="right"
                    className={cn("pl-3 pr-2", className)}
                >
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButtonUI>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className={
                    children || renderItems ? ROW_ACTION_MENU_CLASS : "w-36"
                }
                onCloseAutoFocus={(event) => {
                    if (actionChosenRef.current) event.preventDefault();
                    actionChosenRef.current = false;
                }}
            >
                {renderItems && (
                    <SelectionMenuContent
                        renderItems={renderItems}
                        onActionChosen={() => {
                            actionChosenRef.current = true;
                        }}
                    />
                )}
                {children}
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
