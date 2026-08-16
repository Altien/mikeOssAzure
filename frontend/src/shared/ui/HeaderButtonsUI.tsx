import type {
    ButtonHTMLAttributes,
    ComponentProps,
    ReactNode,
} from "react";

export function HeaderButtonsUI({
    className = "",
    ...props
}: ComponentProps<"div">) {
    return (
        <div
            className={`flex shrink-0 items-center gap-2 rounded-full border border-white/70 bg-app-surface px-1 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur-2xl ${className}`}
            {...props}
        />
    );
}

export type HeaderButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    children?: ReactNode;
    className?: string;
    iconOnly?: boolean;
};

export function headerButtonClassName({
    iconOnly = false,
    disabled = false,
    className = "",
}: {
    iconOnly?: boolean;
    disabled?: boolean;
    className?: string;
} = {}) {
    return [
        "flex h-7 items-center justify-center rounded-full text-sm transition-colors disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-300",
        "hover:bg-app-surface-hover",
        "active:bg-app-surface-active",
        iconOnly ? "w-7" : "w-7 gap-1.5 px-0 sm:w-auto sm:px-3",
        disabled ? "cursor-default" : "cursor-pointer",
        "text-gray-500 hover:text-gray-900",
        className,
    ]
        .filter(Boolean)
        .join(" ");
}

export function HeaderButtonUI({
    children,
    className,
    iconOnly = false,
    disabled,
    type = "button",
    ...props
}: HeaderButtonUIProps) {
    return (
        <button
            type={type}
            disabled={disabled}
            className={headerButtonClassName({
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
