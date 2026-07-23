import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

const { mockGetBrowserAccessToken } = vi.hoisted(() => ({
    mockGetBrowserAccessToken: vi.fn(),
}));

vi.mock("@/lib/auth-token", () => ({
    getBrowserAccessToken: mockGetBrowserAccessToken,
}));

import { useDocumentVersions } from "./useDocumentVersions";

beforeEach(() => {
    mockGetBrowserAccessToken.mockReset();
    mockGetBrowserAccessToken.mockResolvedValue("tok");
});

const FIXTURE_VERSIONS = [
    { id: "v1", version_number: 1, source: "upload", created_at: "2026-01-01" },
    { id: "v2", version_number: 2, source: "assistant_edit", created_at: "2026-01-02" },
];

describe("useDocumentVersions: idle / disabled", () => {
    it("does nothing when documentId is null", () => {
        const { result } = renderHook(() => useDocumentVersions(null));

        expect(result.current.versions).toEqual([]);
        expect(result.current.currentVersionId).toBeNull();
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it("does nothing when documentId is undefined", () => {
        const { result } = renderHook(() => useDocumentVersions(undefined));

        expect(result.current.loading).toBe(false);
        expect(result.current.versions).toEqual([]);
    });
});

describe("useDocumentVersions: fetch lifecycle", () => {
    it("fetches versions for the given documentId and exposes them", async () => {
        let receivedAuth: string | null = null;
        let receivedPath: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/versions", ({ request, params }) => {
                receivedAuth = request.headers.get("Authorization");
                receivedPath = String(params.id);
                return HttpResponse.json({
                    versions: FIXTURE_VERSIONS,
                    current_version_id: "v2",
                });
            }),
        );

        const { result } = renderHook(() => useDocumentVersions("doc-abc"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.versions).toEqual(FIXTURE_VERSIONS);
        expect(result.current.currentVersionId).toBe("v2");
        expect(result.current.error).toBeNull();
        expect(receivedAuth).toBe("Bearer tok");
        expect(receivedPath).toBe("doc-abc");
    });

    it("returns empty arrays + null current when the backend omits the keys", async () => {
        server.use(
            http.get("*/api/single-documents/:id/versions", () =>
                // No `versions` or `current_version_id` fields.
                HttpResponse.json({}),
            ),
        );

        const { result } = renderHook(() => useDocumentVersions("doc-1"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.versions).toEqual([]);
        expect(result.current.currentVersionId).toBeNull();
    });

    it("sets an error string when the backend returns non-2xx", async () => {
        server.use(
            http.get("*/api/single-documents/:id/versions", () =>
                HttpResponse.text("internal", { status: 500 }),
            ),
        );

        const { result } = renderHook(() => useDocumentVersions("doc-1"));

        await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
        expect(result.current.loading).toBe(false);
        expect(result.current.versions).toEqual([]);
    });

    it("omits the Authorization header when there is no token", async () => {
        mockGetBrowserAccessToken.mockResolvedValue(null);
        let receivedAuth: string | null = "(not-set)";
        server.use(
            http.get("*/api/single-documents/:id/versions", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return HttpResponse.json({ versions: [], current_version_id: null });
            }),
        );

        const { result } = renderHook(() => useDocumentVersions("doc-1"));
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(receivedAuth).toBeNull();
    });
});

describe("useDocumentVersions: refetch triggers", () => {
    it("refetches when documentId changes", async () => {
        const calls: string[] = [];
        server.use(
            http.get("*/api/single-documents/:id/versions", ({ params }) => {
                calls.push(String(params.id));
                return HttpResponse.json({
                    versions: [
                        {
                            id: `v-${params.id}`,
                            version_number: 1,
                            source: "upload",
                            created_at: "2026-01-01",
                        },
                    ],
                    current_version_id: `v-${params.id}`,
                });
            }),
        );

        const { result, rerender } = renderHook(
            ({ docId }) => useDocumentVersions(docId),
            { initialProps: { docId: "alpha" } },
        );

        await waitFor(() =>
            expect(result.current.currentVersionId).toBe("v-alpha"),
        );

        rerender({ docId: "beta" });

        await waitFor(() =>
            expect(result.current.currentVersionId).toBe("v-beta"),
        );
        expect(calls).toEqual(["alpha", "beta"]);
    });

    it("refetches when refreshKey changes", async () => {
        let callCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/versions", () => {
                callCount += 1;
                return HttpResponse.json({
                    versions: [
                        {
                            id: `v${callCount}`,
                            version_number: callCount,
                            source: "upload",
                            created_at: "2026-01-01",
                        },
                    ],
                    current_version_id: `v${callCount}`,
                });
            }),
        );

        const { result, rerender } = renderHook(
            ({ rk }) => useDocumentVersions("doc-1", rk),
            { initialProps: { rk: 0 } },
        );

        await waitFor(() => expect(result.current.currentVersionId).toBe("v1"));

        rerender({ rk: 1 });

        await waitFor(() => expect(result.current.currentVersionId).toBe("v2"));
        expect(callCount).toBe(2);
    });

    it("refresh() forces a refetch even without prop changes", async () => {
        let callCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/versions", () => {
                callCount += 1;
                return HttpResponse.json({
                    versions: [],
                    current_version_id: `c${callCount}`,
                });
            }),
        );

        const { result } = renderHook(() => useDocumentVersions("doc-1"));
        await waitFor(() => expect(result.current.currentVersionId).toBe("c1"));

        await act(async () => {
            result.current.refresh();
        });

        await waitFor(() => expect(result.current.currentVersionId).toBe("c2"));
    });

    it("does not crash when unmounted mid-fetch (cancelled-effect guard)", async () => {
        // Hold the response open, unmount, then release.  The
        // cancelled flag must prevent setVersions / setError /
        // setLoading from firing on an unmounted hook.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        server.use(
            http.get("*/api/single-documents/:id/versions", async () => {
                await gate;
                return HttpResponse.json({
                    versions: FIXTURE_VERSIONS,
                    current_version_id: "v2",
                });
            }),
        );

        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = renderHook(() => useDocumentVersions("doc-x"));

        unmount();
        await act(async () => {
            release();
            await new Promise((r) => setTimeout(r, 10));
        });

        // No "state update on unmounted component" warning fired —
        // the cancelled flag did its job.
        const offendingWarning = errSpy.mock.calls.find((args) =>
            String(args[0]).includes("unmounted"),
        );
        expect(offendingWarning).toBeUndefined();
        errSpy.mockRestore();
    });

    it("error path respects the cancelled guard", async () => {
        // Same as above but the response is an error — the catch
        // branch also needs to honour the cancelled flag.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        server.use(
            http.get("*/api/single-documents/:id/versions", async () => {
                await gate;
                return HttpResponse.text("nope", { status: 500 });
            }),
        );

        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = renderHook(() => useDocumentVersions("doc-y"));

        unmount();
        await act(async () => {
            release();
            await new Promise((r) => setTimeout(r, 10));
        });

        const offendingWarning = errSpy.mock.calls.find((args) =>
            String(args[0]).includes("unmounted"),
        );
        expect(offendingWarning).toBeUndefined();
        errSpy.mockRestore();
    });

    it("clears state when documentId becomes null", async () => {
        server.use(
            http.get("*/api/single-documents/:id/versions", () =>
                HttpResponse.json({
                    versions: FIXTURE_VERSIONS,
                    current_version_id: "v2",
                }),
            ),
        );

        const { result, rerender } = renderHook(
            ({ id }: { id: string | null }) => useDocumentVersions(id),
            { initialProps: { id: "doc-1" as string | null } },
        );
        await waitFor(() =>
            expect(result.current.versions.length).toBeGreaterThan(0),
        );

        rerender({ id: null });

        expect(result.current.versions).toEqual([]);
        expect(result.current.currentVersionId).toBeNull();
    });
});
