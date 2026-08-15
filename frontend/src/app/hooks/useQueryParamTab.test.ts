import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
    pathname: "/projects",
    searchParams: new URLSearchParams(),
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({
        push: navigation.push,
        replace: navigation.replace,
    }),
    useSearchParams: () => navigation.searchParams,
}));

import {
    hrefWithTab,
    useQueryParamTab,
} from "./useQueryParamTab";

describe("query-param tabs", () => {
    beforeEach(() => {
        navigation.pathname = "/projects";
        navigation.searchParams = new URLSearchParams();
        vi.clearAllMocks();
    });

    it("builds tab URLs while preserving unrelated query parameters", () => {
        expect(
            hrefWithTab(
                "/workflows",
                "assistant",
                new URLSearchParams("emptyStates=1&tab=all"),
            ),
        ).toBe("/workflows?emptyStates=1&tab=assistant");
        expect(hrefWithTab("/projects", "all")).toBe(
            "/projects?tab=all",
        );
    });

    it("uses a valid URL tab and pushes subsequent tab changes", () => {
        navigation.searchParams = new URLSearchParams(
            "tab=mine&emptyStates=1",
        );
        const { result } = renderHook(() =>
            useQueryParamTab(["all", "mine"] as const, "all"),
        );

        expect(result.current[0]).toBe("mine");
        expect(navigation.replace).not.toHaveBeenCalled();

        act(() => result.current[1]("all", "/another-project-list"));
        expect(navigation.push).toHaveBeenCalledWith(
            "/another-project-list?tab=all&emptyStates=1",
            { scroll: false },
        );
    });

    it("canonicalizes missing and invalid tabs to the default", () => {
        const { result, unmount } = renderHook(() =>
            useQueryParamTab(["all", "mine"] as const, "all"),
        );
        expect(result.current[0]).toBe("all");
        expect(navigation.replace).toHaveBeenCalledWith(
            "/projects?tab=all",
            { scroll: false },
        );
        unmount();

        vi.clearAllMocks();
        navigation.searchParams = new URLSearchParams("tab=unknown");
        renderHook(() =>
            useQueryParamTab(["all", "mine"] as const, "all"),
        );
        expect(navigation.replace).toHaveBeenCalledWith(
            "/projects?tab=all",
            { scroll: false },
        );
    });

    it("can force a route-owned default or disable URL synchronization", () => {
        navigation.searchParams = new URLSearchParams("tab=assistant");
        const forced = renderHook(() =>
            useQueryParamTab(
                ["assistant", "addons"] as const,
                "addons",
                true,
            ),
        );
        expect(forced.result.current[0]).toBe("addons");
        expect(navigation.replace).toHaveBeenCalledWith(
            "/projects?tab=addons",
            { scroll: false },
        );
        forced.unmount();

        vi.clearAllMocks();
        renderHook(() =>
            useQueryParamTab(
                ["prompt", "assets"] as const,
                "prompt",
                false,
                false,
            ),
        );
        expect(navigation.replace).not.toHaveBeenCalled();
    });

});
