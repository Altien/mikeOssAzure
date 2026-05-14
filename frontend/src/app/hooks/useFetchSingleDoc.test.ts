import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";

const { mockGetBrowserAccessToken, mockBounceIfUnauthorized } = vi.hoisted(() => ({
    mockGetBrowserAccessToken: vi.fn(),
    mockBounceIfUnauthorized: vi.fn(),
}));

vi.mock("@/lib/auth-token", () => ({
    getBrowserAccessToken: mockGetBrowserAccessToken,
    bounceIfUnauthorized: mockBounceIfUnauthorized,
}));

import { useFetchSingleDoc } from "./useFetchSingleDoc";

beforeEach(() => {
    mockGetBrowserAccessToken.mockReset();
    mockGetBrowserAccessToken.mockResolvedValue("tok");
    mockBounceIfUnauthorized.mockReset();
});

describe("useFetchSingleDoc: disabled when documentId is missing", () => {
    it("does not fetch when documentId is null", () => {
        const { result } = renderHook(() => useFetchSingleDoc(null));

        expect(result.current.result).toBeNull();
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });
});

describe("useFetchSingleDoc: content-type branching", () => {
    it("returns a pdf result + buffer when content-type is application/pdf", async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        server.use(
            http.get("*/api/single-documents/:id/display", () =>
                new HttpResponse(bytes, {
                    headers: { "Content-Type": "application/pdf" },
                }),
            ),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-pdf"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.result).not.toBeNull();
        expect(result.current.result?.type).toBe("pdf");
        if (result.current.result?.type === "pdf") {
            expect(new Uint8Array(result.current.result.buffer)).toEqual(bytes);
        }
        expect(mockBounceIfUnauthorized).toHaveBeenCalledOnce();
    });

    it("returns a docx result (no buffer) when content-type is NOT application/pdf", async () => {
        server.use(
            http.get("*/api/single-documents/:id/display", () =>
                new HttpResponse(new Uint8Array([1, 2, 3]), {
                    headers: {
                        "Content-Type":
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    },
                }),
            ),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-docx"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.result).toEqual({ type: "docx" });
    });

    it("treats a missing content-type header as docx (fallback branch)", async () => {
        server.use(
            http.get("*/api/single-documents/:id/display", () =>
                new HttpResponse(new Uint8Array([0]), { headers: {} }),
            ),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-no-ct"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.result).toEqual({ type: "docx" });
    });
});

describe("useFetchSingleDoc: version targeting", () => {
    it("encodes versionId into the query string", async () => {
        let receivedUrl: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/display", ({ request }) => {
                receivedUrl = new URL(request.url).search;
                return new HttpResponse(new Uint8Array([0x25, 0x50]), {
                    headers: { "Content-Type": "application/pdf" },
                });
            }),
        );

        const { result } = renderHook(() =>
            useFetchSingleDoc("doc-1", "v with spaces"),
        );

        await waitFor(() => expect(result.current.loading).toBe(false));
        // encodeURIComponent (not URLSearchParams) → spaces become %20.
        expect(receivedUrl).toBe("?version_id=v%20with%20spaces");
    });

    it("does NOT add the query string when versionId is null/undefined", async () => {
        let receivedUrl: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/display", ({ request }) => {
                receivedUrl = new URL(request.url).search;
                return new HttpResponse(new Uint8Array([0]), {
                    headers: { "Content-Type": "application/pdf" },
                });
            }),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-1"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(receivedUrl).toBe("");
    });

    it("dedupes repeated renders with the same (documentId, versionId) key", async () => {
        // The hook's prevKeyRef ensures the effect body only runs once
        // per (documentId, versionId) tuple, even on rerender storms.
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/display", () => {
                fetchCount += 1;
                return new HttpResponse(new Uint8Array([0x25, 0x50]), {
                    headers: { "Content-Type": "application/pdf" },
                });
            }),
        );

        const { result, rerender } = renderHook(
            ({ id, v }: { id: string; v: string | null }) =>
                useFetchSingleDoc(id, v),
            { initialProps: { id: "doc-1", v: "v1" as string | null } },
        );

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(fetchCount).toBe(1);

        // Rerender with the SAME key — no new fetch.
        rerender({ id: "doc-1", v: "v1" });
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchCount).toBe(1);

        // Rerender with a different version — refetches.
        rerender({ id: "doc-1", v: "v2" });
        await waitFor(() => expect(fetchCount).toBe(2));
    });
});

describe("useFetchSingleDoc: error handling", () => {
    it("sets a generic error message on non-2xx", async () => {
        // Error messages are user-facing on the doc-view UI; the
        // string is "Failed to load document." rather than the
        // HTTP code so the user doesn't see "HTTP 500".
        server.use(
            http.get("*/api/single-documents/:id/display", () =>
                HttpResponse.text("internal", { status: 500 }),
            ),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-err"));

        await waitFor(() =>
            expect(result.current.error).toBe("Failed to load document."),
        );
        expect(result.current.result).toBeNull();
        expect(result.current.loading).toBe(false);
    });

    it("does not crash when unmounted mid-fetch (cancelled-effect guard)", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        server.use(
            http.get("*/api/single-documents/:id/display", async () => {
                await gate;
                return new HttpResponse(new Uint8Array([0]), {
                    headers: { "Content-Type": "application/pdf" },
                });
            }),
        );

        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { unmount } = renderHook(() => useFetchSingleDoc("doc-unmount"));

        unmount();
        await release();
        await new Promise((r) => setTimeout(r, 10));

        const offending = errSpy.mock.calls.find((args) =>
            String(args[0]).includes("unmounted"),
        );
        expect(offending).toBeUndefined();
        errSpy.mockRestore();
    });

    it("calls bounceIfUnauthorized on every response (delegating 401 handling)", async () => {
        server.use(
            http.get("*/api/single-documents/:id/display", () =>
                new HttpResponse(new Uint8Array([0]), {
                    headers: { "Content-Type": "application/pdf" },
                }),
            ),
        );

        const { result } = renderHook(() => useFetchSingleDoc("doc-1"));
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(mockBounceIfUnauthorized).toHaveBeenCalledOnce();
    });
});
