"use client";

import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type SearchParamsLike = string | Pick<URLSearchParams, "toString">;

export function hrefWithTab(
    pathname: string,
    tab: string,
    searchParams?: SearchParamsLike,
): string {
    const params = new URLSearchParams(
        typeof searchParams === "string"
            ? searchParams
            : searchParams?.toString(),
    );
    params.set("tab", tab);
    return `${pathname}?${params.toString()}`;
}

/**
 * Makes a local page tab URL-addressable while preserving unrelated query
 * parameters. Missing or invalid values are replaced with the default so the
 * URL always describes the visible tab.
 */
export function useQueryParamTab<T extends string>(
    tabs: readonly T[],
    defaultTab: T,
    forceDefault = false,
    enabled = true,
) {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const requestedTab = searchParams.get("tab");
    const activeTab = !forceDefault && tabs.includes(requestedTab as T)
        ? (requestedTab as T)
        : defaultTab;
    const serializedSearchParams = searchParams.toString();

    useEffect(() => {
        if (!enabled) return;
        if (requestedTab === activeTab) return;
        router.replace(
            hrefWithTab(pathname, activeTab, serializedSearchParams),
            {
                scroll: false,
            },
        );
    }, [
        activeTab,
        enabled,
        pathname,
        requestedTab,
        router,
        serializedSearchParams,
    ]);

    const setActiveTab = useCallback(
        (tab: T, targetPathname = pathname) => {
            router.push(
                hrefWithTab(targetPathname, tab, serializedSearchParams),
                { scroll: false },
            );
        },
        [pathname, router, serializedSearchParams],
    );

    return [activeTab, setActiveTab] as const;
}
