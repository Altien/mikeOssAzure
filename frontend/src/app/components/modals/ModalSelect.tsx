"use client";

import { useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/DropdownUI";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type ModalSelectOption =
    | string
    | {
          value: string;
          label: string;
          icon?: LucideIcon;
          iconClassName?: string;
      };

interface ModalSelectProps {
    id: string;
    value: string;
    options: readonly ModalSelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    className?: string;
    menuClassName?: string;
    searchable?: boolean;
    searchPlaceholder?: string;
}

function normalizeOption(option: ModalSelectOption) {
    return typeof option === "string"
        ? { value: option, label: option }
        : option;
}

export function ModalSelect({
    id,
    value,
    options,
    onChange,
    placeholder = "Select...",
    disabled = false,
    open,
    onOpenChange,
    className,
    menuClassName,
    searchable = false,
    searchPlaceholder = "Search options...",
}: ModalSelectProps) {
    const [internalOpen, setInternalOpen] = useState(false);
    const [query, setQuery] = useState("");
    const isOpen = open ?? internalOpen;
    const normalizedOptions = options.map(normalizeOption);
    const normalizedQuery = query.trim().toLowerCase();
    const visibleOptions = normalizedQuery
        ? normalizedOptions.filter(
              (option) =>
                  option.label.toLowerCase().includes(normalizedQuery) ||
                  option.value.toLowerCase().includes(normalizedQuery),
          )
        : normalizedOptions;
    const selected = normalizedOptions.find((option) => option.value === value);
    const hasValue = value.trim().length > 0;

    function setOpen(next: boolean) {
        if (!next) setQuery("");
        onOpenChange?.(next);
        if (open === undefined) {
            setInternalOpen(next);
        }
    }

    function handleSelect(nextValue: string) {
        setOpen(false);
        onChange(nextValue);
    }

    return (
        <Dropdown open={isOpen} onOpenChange={setOpen}>
            <DropdownTrigger asChild>
                <button
                    id={id}
                    type="button"
                    disabled={disabled}
                    className={cn(
                        `flex h-10 w-full items-center justify-between rounded-xl px-3 text-sm text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS} backdrop-blur-xl transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-60`,
                        isOpen && LIQUID_GLASS_SELECTED_CLASS,
                        className,
                    )}
                >
                    <span className="flex min-w-0 items-center gap-2">
                        {selected?.icon && (
                            <selected.icon
                                className={cn(
                                    "h-3.5 w-3.5 shrink-0",
                                    selected.iconClassName,
                                )}
                            />
                        )}
                        <span
                            className={cn(
                                "truncate",
                                !selected && !hasValue && "text-gray-400",
                            )}
                        >
                            {selected?.label ??
                                (hasValue ? value : placeholder)}
                        </span>
                    </span>
                    <ChevronDown
                        className={cn(
                            "ml-2 h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform",
                            isOpen && "rotate-180",
                        )}
                    />
                </button>
            </DropdownTrigger>
            {isOpen && !disabled && (
                <DropdownContent
                    align="start"
                    sideOffset={4}
                    collisionPadding={12}
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                    className={cn(
                        "max-h-56 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-2xl p-1",
                        menuClassName,
                    )}
                >
                    {normalizedOptions.map((option) => (
                        <DropdownItem
                            key={option.value}
                            textValue={option.label}
                            selected={option.value === value}
                            onSelect={() => handleSelect(option.value)}
                            className={cn(
                                "theme-dropdown-item flex w-full items-center rounded-md px-3 py-2 text-left text-xs transition-all",
                                option.value === value
                                    ? "theme-dropdown-selected text-gray-900"
                                    : "text-gray-700",
                            )}
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                {option.icon && (
                                    <option.icon
                                        className={cn(
                                            "h-3.5 w-3.5 shrink-0",
                                            option.iconClassName,
                                        )}
                                    />
                                )}
                                <span className="truncate">
                                    {option.label}
                                </span>
                            </span>
                        </DropdownItem>
                    ))}
                </DropdownContent>
            )}
        </Dropdown>
    );
}
