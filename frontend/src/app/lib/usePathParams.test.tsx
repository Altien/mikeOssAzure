import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "" as string | null }));
vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
}));

import { RequirePathParams, RequireResolvedPath } from "./usePathParams";

describe("static-export route gates", () => {
    beforeEach(() => {
        navigation.pathname = "";
    });

    it("RequireResolvedPath waits for a live, non-placeholder URL", () => {
        navigation.pathname = null;
        const { rerender } = render(
            <RequireResolvedPath>page</RequireResolvedPath>,
        );
        expect(screen.queryByText("page")).toBeNull();

        navigation.pathname = "/projects/p1/assistant/chat/_";
        rerender(<RequireResolvedPath>page</RequireResolvedPath>);
        expect(screen.queryByText("page")).toBeNull();

        navigation.pathname = "/projects/p1/assistant/chat/c1";
        rerender(<RequireResolvedPath>page</RequireResolvedPath>);
        expect(screen.getByText("page")).toBeTruthy();
    });

    it("RequireResolvedPath keeps a chat page mounted on its new-chat URL", () => {
        navigation.pathname = "/assistant";
        render(<RequireResolvedPath>page</RequireResolvedPath>);
        expect(screen.getByText("page")).toBeTruthy();
    });

    it("RequirePathParams still requires every id", () => {
        navigation.pathname = "/assistant";
        render(
            <RequirePathParams pattern="/assistant/chat/:id">
                page
            </RequirePathParams>,
        );
        expect(screen.queryByText("page")).toBeNull();
    });
});
