"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { settingsTabButtonClassName } from "@/app/(pages)/settings/settingsStyles";
import {
    PAGE_HEADER_ROW_CLASS,
    PAGE_HEADER_TITLE_CLASS,
} from "@/app/components/shared/pageHeaderStyles";
import { cn } from "@/app/lib/utils";

export interface SettingsShellTab {
    id: string;
    label: string;
    href: string;
}

/**
 * The frame every settings area shares: a serif title, the sections down the
 * side (across the top when the page is narrow) and the open section beside
 * them. A person's settings and an organization's use the same one, so the
 * two read as the same kind of place.
 *
 * `rootHref` is the area's first section, whose path is a prefix of every
 * other's: it is the open one only on an exact match.
 */
export function SettingsShell({
    title,
    navLabel,
    tabs,
    rootHref,
    children,
}: {
    title: ReactNode;
    /** The navigation's accessible name. */
    navLabel: string;
    tabs: SettingsShellTab[];
    rootHref: string;
    children: ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            {/* The same title, on the same line, as every other page's
                header: only the column it sits in is the settings one. */}
            <header
                className={cn(
                    "mx-auto flex w-full max-w-5xl shrink-0 items-center px-6",
                    PAGE_HEADER_ROW_CLASS,
                )}
            >
                <h1 className={cn(PAGE_HEADER_TITLE_CLASS, "text-gray-900")}>
                    {title}
                </h1>
            </header>

            <main className="@container/settings mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 @min-[52rem]/settings:grid-cols-[224px_minmax(0,1fr)] @min-[52rem]/settings:gap-x-10">
                    <nav
                        aria-label={navLabel}
                        className="z-10 -ml-3 min-w-0 self-start @min-[52rem]/settings:sticky @min-[52rem]/settings:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1">
                                <ul className="mb-0 flex gap-1 @min-[52rem]/settings:flex-col">
                                    {tabs.map((tab) => {
                                        const active =
                                            pathname === tab.href ||
                                            (tab.href !== rootHref &&
                                                pathname.startsWith(tab.href));
                                        return (
                                            <li key={tab.id}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        router.push(tab.href)
                                                    }
                                                    className={settingsTabButtonClassName(
                                                        active,
                                                    )}
                                                >
                                                    {tab.label}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}
