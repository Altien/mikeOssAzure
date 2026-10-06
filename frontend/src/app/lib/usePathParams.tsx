"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Static-export divergence (OSS-6): renders `children` only once every
 * `:param` in `pattern` resolves to a real (non-empty, non-`"_"`) value.
 * Mounted by the dynamic segments' server `layout.tsx` files so the
 * upstream page bodies below them never run their fetching effects with a
 * placeholder id — the prerendered shell and the pre-hydration tick render
 * nothing here, which also keeps server and first client render identical.
 */
export function RequirePathParams({
    pattern,
    children,
}: {
    pattern: string;
    children: ReactNode;
}) {
    const params = usePathParams<string>(pattern);
    const ready = Object.values(params).every((value) => value !== "");
    return ready ? <>{children}</> : null;
}

/**
 * Static-export divergence (sync-log: 6e3ef6fa): for chat pages that move
 * between their new-chat URL and `<chat>/:id` with `history.pushState`
 * (upstream #559 `useChatRoute`). Renders `children` once `usePathname()`
 * has resolved to a live URL that no longer contains the `"_"` placeholder
 * segment. Unlike `RequirePathParams`, an absent chat id (the new-chat URL)
 * keeps the page mounted, so "New chat" does not unmount a streaming answer.
 */
export function RequireResolvedPath({ children }: { children: ReactNode }) {
    const pathname = usePathname() ?? "";
    const ready =
        pathname !== "" &&
        !pathname.split(/[?#]/)[0].split("/").includes("_");
    return ready ? <>{children}</> : null;
}

/**
 * Static-export divergence (OSS-5 / OSS-6, dev-only): the replacement for
 * upstream's `use(params)` / `useParams()` in dynamic-route pages.
 *
 * Under `output: "export"` each dynamic route is prerendered once with the
 * placeholder param `"_"` (declared by `generateStaticParams` in the
 * segment's server `layout.tsx`), and the backend's `findShell` serves that
 * shell for every real URL. Server-baked `params` and `useParams()`
 * therefore always report `"_"`; `usePathname()` is the only source that
 * reflects the live URL (see AGENTS.md "Frontend Dynamic Routes").
 *
 * `pattern` mirrors the route, e.g. `"/projects/:id/assistant/chat/:chatId"`.
 * The pathname is matched as a prefix; each `:name` segment is returned
 * URI-decoded. A param is `""` until `usePathname()` resolves, when the URL
 * does not match, or when it is the `"_"` placeholder — so callers must gate
 * fetching effects on a non-empty id.
 */
export function usePathParams<K extends string>(
    pattern: string,
): Record<K, string> {
    const pathname = usePathname() ?? "";
    return parsePathParams<K>(pattern, pathname);
}

export function parsePathParams<K extends string>(
    pattern: string,
    pathname: string,
): Record<K, string> {
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
    const result = {} as Record<K, string>;
    let matches = true;

    patternParts.forEach((part, index) => {
        const actual = pathParts[index];
        if (part.startsWith(":")) {
            const key = part.slice(1) as K;
            const value =
                matches && actual && actual !== "_"
                    ? safeDecode(actual)
                    : "";
            result[key] = value;
            return;
        }
        if (actual !== part) matches = false;
    });

    if (!matches) {
        for (const part of patternParts) {
            if (part.startsWith(":")) result[part.slice(1) as K] = "";
        }
    }
    return result;
}

function safeDecode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
