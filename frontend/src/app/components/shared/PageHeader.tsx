"use client";

import {
    Fragment,
    isValidElement,
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type ReactNode,
} from "react";
import { ChevronLeft, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderBreadcrumb {
    label?: ReactNode;
    suffix?: ReactNode;
    onClick?: () => void;
    loading?: boolean;
    skeletonClassName?: string;
    title?: string;
}

type PageHeaderButtonAction = {
    type?: "button";
    icon?: ReactNode;
    label?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    variant?: "default" | "danger";
    iconOnly?: boolean;
    className?: string;
    tooltip?: ReactNode;
};

type PageHeaderSearchAction = {
    type: "search";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
};

type PageHeaderDeleteAction = {
    type: "delete";
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    title?: string;
};

type PageHeaderNewAction = {
    type: "new";
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    title?: string;
};

type PageHeaderCustomAction = {
    type: "custom";
    render: ReactNode;
};

export type PageHeaderAction =
    | PageHeaderButtonAction
    | PageHeaderSearchAction
    | PageHeaderDeleteAction
    | PageHeaderNewAction
    | PageHeaderCustomAction
    | ReactNode;

interface PageHeaderProps {
    children?: ReactNode;
    actions?: PageHeaderAction[];
    actionGroups?: PageHeaderAction[][];
    align?: "center" | "start";
    shrink?: boolean;
    className?: string;
    actionGap?: "sm" | "md" | "lg";
    breadcrumbs?: PageHeaderBreadcrumb[];
}

const actionGapClassName = {
    sm: "gap-2.5",
    md: "gap-2.5",
    lg: "gap-2.5",
};

export function PageHeader({
    children,
    actions,
    actionGroups,
    align = "center",
    shrink = false,
    className,
    actionGap = "sm",
    breadcrumbs,
}: PageHeaderProps) {
    const headerContent = breadcrumbs?.length ? (
        <PageHeaderBreadcrumbs items={breadcrumbs} />
    ) : (
        children
    );
    const actionItems = actions?.filter(Boolean) ?? [];
    const groupedActionItems =
        actionGroups
            ?.map((group) => group.filter(Boolean))
            .filter((group) => group.length > 0) ??
        (actionItems.length > 0 ? [actionItems] : []);

    return (
        <div
            className={cn(
                "flex justify-between",
                align === "start" ? "items-start" : "items-center",
                "px-4 md:px-10",
                "pb-4 pt-5.5",
                shrink && "shrink-0",
                className,
            )}
        >
            {headerContent}
            {groupedActionItems.length > 0 && (
                <div className="ml-4 flex shrink-0 items-center gap-3">
                    {groupedActionItems.map((group, groupIndex) => (
                        <div
                            key={groupIndex}
                            className={cn(
                                "flex shrink-0 items-center",
                                actionGapClassName[actionGap],
                                "rounded-full border border-white/70 bg-white px-1 py-1 shadow-[0_-1px_3px_rgba(15,23,42,0.03),0_2px_7px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.82),inset_0_-3px_7px_rgba(255,255,255,0.13)] backdrop-blur-2xl",
                            )}
                        >
                            {group.map((action, index) => (
                                <Fragment key={index}>
                                    <PageHeaderActionRenderer action={action} />
                                </Fragment>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PageHeaderActionRenderer({ action }: { action: PageHeaderAction }) {
    if (!isPageHeaderActionObject(action)) return <>{action}</>;

    switch (action.type) {
        case "search":
            return <PageHeaderSearchActionControl action={action} />;
        case "delete":
            return <PageHeaderDeleteActionControl action={action} />;
        case "new":
            return <PageHeaderNewActionControl action={action} />;
        case "custom":
            return <>{action.render}</>;
        case "button":
        default:
            return <PageHeaderButtonActionControl action={action} />;
    }
}

function isPageHeaderActionObject(
    action: PageHeaderAction,
): action is Exclude<PageHeaderAction, ReactNode> {
    return !!action && typeof action === "object" && !isValidElement(action);
}

function PageHeaderButtonActionControl({
    action,
}: {
    action: PageHeaderButtonAction;
}) {
    const iconOnly = action.iconOnly ?? !action.label;
    return (
        <div className={action.tooltip ? "relative group" : undefined}>
            <PageHeaderActionButton
                onClick={action.onClick}
                disabled={action.disabled}
                title={action.title}
                aria-label={action.title}
                variant={action.variant}
                iconOnly={iconOnly}
                className={action.className}
            >
                {action.icon}
                {action.label}
            </PageHeaderActionButton>
            {action.tooltip && (
                <div className="pointer-events-none absolute right-0 top-full mt-1.5 z-10 hidden items-center whitespace-nowrap rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg group-hover:flex">
                    {action.tooltip}
                </div>
            )}
        </div>
    );
}

function PageHeaderNewActionControl({
    action,
}: {
    action: PageHeaderNewAction;
}) {
    const title = action.title ?? "New";
    return (
        <PageHeaderActionButton
            onClick={action.onClick}
            disabled={action.disabled || action.loading}
            title={title}
            aria-label={title}
            iconOnly
        >
            {action.loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Plus className="h-4 w-4" />
            )}
        </PageHeaderActionButton>
    );
}

function PageHeaderDeleteActionControl({
    action,
}: {
    action: PageHeaderDeleteAction;
}) {
    const title = action.title ?? "Delete";
    return (
        <PageHeaderActionButton
            onClick={action.onClick}
            disabled={action.disabled || action.loading}
            title={title}
            aria-label={title}
            iconOnly
            variant="danger"
        >
            {action.loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Trash2 className="h-4 w-4" />
            )}
        </PageHeaderActionButton>
    );
}

function PageHeaderSearchActionControl({
    action,
}: {
    action: PageHeaderSearchAction;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const placeholder = action.placeholder ?? "Search…";

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                action.onChange("");
            }
        }
        if (open) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open, action]);

    return (
        <div ref={ref} className="relative flex items-center">
            {open ? (
                <div
                    className={cn(
                        pageHeaderActionControlClassName({
                            className:
                                "cursor-text justify-start gap-2 px-3 text-gray-700 hover:text-gray-700",
                        }),
                        "w-56 bg-gray-100 sm:w-80",
                    )}
                >
                    <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    <input
                        autoFocus
                        type="text"
                        placeholder={placeholder}
                        value={action.value}
                        onChange={(e) => action.onChange(e.target.value)}
                        className="flex-1 text-sm text-gray-700 placeholder:text-gray-400 outline-none bg-transparent"
                    />
                </div>
            ) : (
                <PageHeaderActionButton
                    onClick={() => setOpen(true)}
                    iconOnly
                    title={placeholder}
                    aria-label={placeholder}
                >
                    <Search className="h-4 w-4" />
                </PageHeaderActionButton>
            )}
        </div>
    );
}

type PageHeaderActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "default" | "danger";
    iconOnly?: boolean;
};

type PageHeaderActionControlClassNameOptions = {
    variant?: "default" | "danger";
    iconOnly?: boolean;
    disabled?: boolean;
    className?: string;
};

function pageHeaderActionControlClassName({
    variant = "default",
    iconOnly = false,
    disabled = false,
    className,
}: PageHeaderActionControlClassNameOptions = {}) {
    return cn(
        "flex h-7 items-center justify-center rounded-full text-sm transition-colors hover:bg-gray-100 active:bg-gray-100 disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-300",
        iconOnly ? "w-7" : "gap-1.5 px-3",
        disabled ? "cursor-default" : "cursor-pointer",
        "hover:bg-gray-100 active:bg-gray-100",
        variant === "danger"
            ? "text-gray-500 hover:text-red-600"
            : "text-gray-500 hover:text-gray-900",
        className,
    );
}

function PageHeaderActionButton({
    children,
    className,
    variant = "default",
    iconOnly = false,
    disabled,
    ...props
}: PageHeaderActionButtonProps) {
    return (
        <button
            disabled={disabled}
            className={pageHeaderActionControlClassName({
                variant,
                iconOnly,
                disabled,
                className,
            })}
            {...props}
        >
            {children}
        </button>
    );
}

function PageHeaderBreadcrumbs({ items }: { items: PageHeaderBreadcrumb[] }) {
    const current = items[items.length - 1];
    const parent = [...items]
        .slice(0, -1)
        .reverse()
        .find((item) => item.onClick);

    return (
        <div className="flex min-w-0 items-center gap-1.5 text-2xl font-medium font-serif">
            {parent?.onClick && (
                <button
                    onClick={parent.onClick}
                    className="shrink-0 text-gray-400 transition-colors hover:text-gray-600 sm:hidden"
                    title={parent.title ?? "Back"}
                    aria-label={parent.title ?? "Back"}
                >
                    <ChevronLeft className="h-5 w-5" />
                </button>
            )}
            <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
                {items.map((item, index) => (
                    <BreadcrumbItem
                        key={index}
                        item={item}
                        current={index === items.length - 1}
                        showSuffix
                    />
                ))}
            </div>
            <div className="min-w-0 sm:hidden">
                {current ? (
                    <BreadcrumbItem item={current} current showSuffix={false} />
                ) : null}
            </div>
        </div>
    );
}

function BreadcrumbItem({
    item,
    current,
    showSuffix,
}: {
    item: PageHeaderBreadcrumb;
    current: boolean;
    showSuffix: boolean;
}) {
    const content = item.loading ? (
        <div
            className={cn(
                "h-6 rounded bg-gray-100 animate-pulse",
                item.skeletonClassName ?? "w-32",
            )}
        />
    ) : (
        <>
            <span className="truncate">{item.label}</span>
            {showSuffix && item.suffix}
        </>
    );

    const className = cn(
        "min-w-0 truncate transition-colors",
        current
            ? "text-gray-900"
            : item.onClick
              ? "text-gray-500 hover:text-gray-700"
              : "text-gray-500",
    );

    return (
        <>
            {current ? (
                <span className={className}>{content}</span>
            ) : item.onClick ? (
                <button onClick={item.onClick} className={className}>
                    {content}
                </button>
            ) : (
                <span className={className}>{content}</span>
            )}
            {!current && <span className="shrink-0 text-gray-300">›</span>}
        </>
    );
}
