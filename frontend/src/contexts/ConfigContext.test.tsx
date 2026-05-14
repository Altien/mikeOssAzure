import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import {
    ConfigProvider,
    useConfig,
    useConfigLoading,
    getCachedAuthProvider,
} from "./ConfigContext";

function Probe() {
    const config = useConfig();
    const loading = useConfigLoading();
    return (
        <div>
            <span data-testid="provider">{config.authProvider}</span>
            <span data-testid="tenant">{config.entra.tenantId}</span>
            <span data-testid="client">{config.entra.clientId}</span>
            <span data-testid="loading">{loading ? "loading" : "ready"}</span>
        </div>
    );
}

describe("ConfigContext: initial render before /config resolves", () => {
    it("seeds authProvider from the localStorage cache key", () => {
        // The provider's useState initializer reads readCachedProvider().
        // This is the fast path that lets module-level helpers
        // (getBrowserAccessToken) answer "what mode are we in?" before
        // /config completes.
        window.localStorage.setItem("mike.config.authProvider", "entra");

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("entra");
        expect(screen.getByTestId("loading")).toHaveTextContent("loading");
    });

    it("defaults to supabase when no cache entry exists", () => {
        // Empty localStorage → DEFAULT_CONFIG.authProvider.
        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("supabase");
    });

    it("ignores a garbage value in the cache key", () => {
        // readCachedProvider only honours the three known string
        // literals — anything else falls back to "supabase".  This is
        // the input-validation pin: if a future change widens the
        // accepted set, this test must be updated deliberately.
        window.localStorage.setItem("mike.config.authProvider", "nonsense");

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("supabase");
    });
});

describe("ConfigContext: /config fetch", () => {
    it("overwrites state and the cache with the fetched config", async () => {
        server.use(
            http.get("*/config", () =>
                HttpResponse.json({
                    authProvider: "entra",
                    entra: { tenantId: "tenant-xyz", clientId: "client-abc" },
                }),
            ),
        );

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("entra");
        expect(screen.getByTestId("tenant")).toHaveTextContent("tenant-xyz");
        expect(screen.getByTestId("client")).toHaveTextContent("client-abc");
        // The cache key is the same one auth-token.ts and the module-
        // level getCachedAuthProvider read.  This is the round-trip.
        expect(window.localStorage.getItem("mike.config.authProvider")).toBe("entra");
    });

    it("keeps the cached fallback when /config returns non-2xx", async () => {
        // !response.ok throws → catch → console.warn → loading=false.
        // State stays at the cached default, no cache write.
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        window.localStorage.setItem("mike.config.authProvider", "local");
        server.use(http.get("*/config", () => new HttpResponse(null, { status: 500 })));

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("local");
        // Cache value untouched — the failed fetch must not poison the
        // cached fast-path read.
        expect(window.localStorage.getItem("mike.config.authProvider")).toBe("local");
        expect(warnSpy).toHaveBeenCalledWith(
            "[config] failed to load runtime config; falling back to cached provider",
            expect.any(Error),
        );
        warnSpy.mockRestore();
    });

    it("keeps the cached fallback when /config rejects (network error)", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        window.localStorage.setItem("mike.config.authProvider", "entra");
        server.use(http.get("*/config", () => HttpResponse.error()));

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(screen.getByTestId("provider")).toHaveTextContent("entra");
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("never leaves loading=true when /config fails", async () => {
        // The finally block must flip loading off even when the fetch
        // throws.  A stuck loading=true would freeze the AuthContext
        // (which waits on configLoading before deciding auth flow).
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        server.use(http.get("*/config", () => HttpResponse.error()));

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );
        warnSpy.mockRestore();
    });
});

describe("ConfigContext: cancelled-effect guard", () => {
    it("does not write state or cache if unmounted before the fetch resolves", async () => {
        // Hold the request open via a deferred response.  Unmount the
        // provider before resolving.  The cancelled flag must prevent
        // setState/writeCachedProvider — neither would crash, but a
        // React act() warning on a state update after unmount is the
        // signal the guard is working.
        const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let resolveFetch!: () => void;
        const gate = new Promise<void>((r) => {
            resolveFetch = r;
        });
        server.use(
            http.get("*/config", async () => {
                await gate;
                return HttpResponse.json({
                    authProvider: "entra",
                    entra: { tenantId: "after-unmount", clientId: "after-unmount" },
                });
            }),
        );
        window.localStorage.setItem("mike.config.authProvider", "supabase");

        const { unmount } = render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        unmount();
        await act(async () => {
            resolveFetch();
            // Let the microtask queue drain so the response handler
            // actually runs (and hits the cancelled guard).
            await Promise.resolve();
            await Promise.resolve();
        });

        // Cache must NOT have been overwritten with the late response.
        expect(window.localStorage.getItem("mike.config.authProvider")).toBe("supabase");
        // And the "state update on unmounted component" warning must
        // not have fired — that's exactly what the cancelled flag
        // exists to prevent.
        const stateAfterUnmountWarning = warnSpy.mock.calls.find((args) =>
            String(args[0]).includes("unmounted"),
        );
        expect(stateAfterUnmountWarning).toBeUndefined();
        warnSpy.mockRestore();
    });
});

describe("ConfigContext: module-level getCachedAuthProvider", () => {
    // This helper exists so getBrowserAccessToken (called outside any
    // React tree) can answer "what auth mode are we in?" without a
    // hook.  The round-trip with ConfigProvider is what makes the
    // cached fast-path safe.
    it("returns the same value the provider just wrote to localStorage", async () => {
        server.use(
            http.get("*/config", () =>
                HttpResponse.json({
                    authProvider: "local",
                    entra: { tenantId: "", clientId: "" },
                }),
            ),
        );

        render(
            <ConfigProvider>
                <Probe />
            </ConfigProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
        );

        expect(getCachedAuthProvider()).toBe("local");
    });

    it("defaults to supabase when nothing is cached", () => {
        expect(getCachedAuthProvider()).toBe("supabase");
    });

    it("returns supabase when the cache holds an unknown value", () => {
        window.localStorage.setItem("mike.config.authProvider", "google");

        expect(getCachedAuthProvider()).toBe("supabase");
    });
});

describe("ConfigContext: useConfig outside a provider", () => {
    it("returns the DEFAULT_CONFIG so consumers don't crash before mount", () => {
        // The context default is { config: DEFAULT_CONFIG, loading: true }.
        // Components that read useConfig() outside a provider tree
        // (e.g. during a partial-hydration race) get the safe default
        // rather than undefined.
        function BareProbe() {
            const config = useConfig();
            return <span data-testid="bare">{config.authProvider}</span>;
        }

        render(<BareProbe />);

        expect(screen.getByTestId("bare")).toHaveTextContent("supabase");
    });
});
