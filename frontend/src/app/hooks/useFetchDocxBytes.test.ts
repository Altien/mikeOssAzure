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

import { useFetchDocxBytes, invalidateDocxBytes } from "./useFetchDocxBytes";

beforeEach(() => {
    mockGetBrowserAccessToken.mockReset();
    mockGetBrowserAccessToken.mockResolvedValue("tok");
    mockBounceIfUnauthorized.mockReset();
    // Each test runs against a fresh cache surface — eviction is per-
    // documentId so we wipe by pattern.
    invalidateDocxBytes("cache-test");
    invalidateDocxBytes("cache-test-2");
    invalidateDocxBytes("dedupe-doc");
    invalidateDocxBytes("err-doc");
    invalidateDocxBytes("evict-doc");
    invalidateDocxBytes("evict-doc-v");
    invalidateDocxBytes("d1");
    invalidateDocxBytes("d2");
});

describe("useFetchDocxBytes: idle / disabled", () => {
    it("does nothing when documentId is null", () => {
        const { result } = renderHook(() => useFetchDocxBytes(null));

        expect(result.current.bytes).toBeNull();
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
        expect(result.current.downloadUrl).toBeNull();
    });
});

describe("useFetchDocxBytes: fetch lifecycle", () => {
    it("fetches bytes, exposes them, and sets downloadUrl on success", async () => {
        let receivedAuth: string | null = null;
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP/.docx magic
        server.use(
            http.get("*/api/single-documents/:id/docx", ({ request }) => {
                receivedAuth = request.headers.get("Authorization");
                return new HttpResponse(bytes);
            }),
        );

        const { result } = renderHook(() => useFetchDocxBytes("d1"));

        await waitFor(() => expect(result.current.bytes).not.toBeNull());
        expect(new Uint8Array(result.current.bytes!)).toEqual(bytes);
        expect(result.current.downloadUrl).toMatch(/\/api\/single-documents\/d1\/docx$/);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
        expect(receivedAuth).toBe("Bearer tok");
        expect(mockBounceIfUnauthorized).toHaveBeenCalled();
    });

    it("encodes versionId into the query string", async () => {
        let receivedSearch: string | null = null;
        server.use(
            http.get("*/api/single-documents/:id/docx", ({ request }) => {
                receivedSearch = new URL(request.url).search;
                return new HttpResponse(new Uint8Array([1]));
            }),
        );

        const { result } = renderHook(() => useFetchDocxBytes("d1", "v with /slash"));

        await waitFor(() => expect(result.current.loading).toBe(false));
        // encodeURIComponent — spaces are %20, slashes are %2F.
        expect(receivedSearch).toBe("?version_id=v%20with%20%2Fslash");
    });

    it("propagates the HTTP error message", async () => {
        server.use(
            http.get("*/api/single-documents/:id/docx", () =>
                HttpResponse.text("oops", { status: 500 }),
            ),
        );

        const { result } = renderHook(() => useFetchDocxBytes("err-doc"));

        await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
        expect(result.current.bytes).toBeNull();
        expect(result.current.loading).toBe(false);
    });
});

describe("useFetchDocxBytes: cache", () => {
    it("a second hook with the same key returns bytes synchronously, no network", async () => {
        const bytes = new Uint8Array([0xaa, 0xbb]);
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/docx", () => {
                fetchCount += 1;
                return new HttpResponse(bytes);
            }),
        );

        // First hook fills the cache.
        const first = renderHook(() => useFetchDocxBytes("cache-test"));
        await waitFor(() => expect(first.result.current.bytes).not.toBeNull());
        expect(fetchCount).toBe(1);

        // Second hook with the same key: cache hit.  bytes available
        // immediately from the useState initializer.
        const second = renderHook(() => useFetchDocxBytes("cache-test"));
        expect(second.result.current.bytes).not.toBeNull();
        expect(new Uint8Array(second.result.current.bytes!)).toEqual(bytes);
        expect(second.result.current.loading).toBe(false);

        // Wait a tick to confirm no late fetch fires.
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchCount).toBe(1);
    });

    it("different versionIds for the same document are separate cache entries", async () => {
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/docx", () => {
                fetchCount += 1;
                return new HttpResponse(
                    new Uint8Array([fetchCount]),
                );
            }),
        );

        const a = renderHook(() => useFetchDocxBytes("cache-test-2", "v1"));
        await waitFor(() => expect(a.result.current.bytes).not.toBeNull());

        const b = renderHook(() => useFetchDocxBytes("cache-test-2", "v2"));
        await waitFor(() => expect(b.result.current.bytes).not.toBeNull());

        expect(fetchCount).toBe(2);
        expect(new Uint8Array(a.result.current.bytes!)).toEqual(new Uint8Array([1]));
        expect(new Uint8Array(b.result.current.bytes!)).toEqual(new Uint8Array([2]));
    });

    it("refetchKey forces a new entry even with identical doc+version", async () => {
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/docx", () => {
                fetchCount += 1;
                return new HttpResponse(new Uint8Array([fetchCount]));
            }),
        );

        const { result, rerender } = renderHook(
            ({ key }: { key: number }) =>
                useFetchDocxBytes("cache-test", "v1", key),
            { initialProps: { key: 0 } },
        );

        await waitFor(() => expect(result.current.bytes).not.toBeNull());
        expect(fetchCount).toBe(1);

        rerender({ key: 1 });

        await waitFor(() => expect(fetchCount).toBe(2));
    });

    it("invalidateDocxBytes(docId, versionId) evicts that single tuple", async () => {
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/docx", () => {
                fetchCount += 1;
                return new HttpResponse(new Uint8Array([fetchCount]));
            }),
        );

        const a = renderHook(() => useFetchDocxBytes("evict-doc-v", "v1"));
        await waitFor(() => expect(a.result.current.bytes).not.toBeNull());

        invalidateDocxBytes("evict-doc-v", "v1");

        // A fresh hook for the SAME tuple now misses the cache.
        const b = renderHook(() => useFetchDocxBytes("evict-doc-v", "v1"));
        await waitFor(() =>
            expect(b.result.current.bytes).not.toBeNull(),
        );
        expect(fetchCount).toBe(2);
    });

    it("invalidateDocxBytes(docId) evicts every version of that document", async () => {
        let fetchCount = 0;
        server.use(
            http.get("*/api/single-documents/:id/docx", () => {
                fetchCount += 1;
                return new HttpResponse(new Uint8Array([fetchCount]));
            }),
        );

        const a = renderHook(() => useFetchDocxBytes("evict-doc", "v1"));
        await waitFor(() => expect(a.result.current.bytes).not.toBeNull());
        const b = renderHook(() => useFetchDocxBytes("evict-doc", "v2"));
        await waitFor(() => expect(b.result.current.bytes).not.toBeNull());

        expect(fetchCount).toBe(2);

        invalidateDocxBytes("evict-doc");

        // Both versions now miss the cache.
        const a2 = renderHook(() => useFetchDocxBytes("evict-doc", "v1"));
        await waitFor(() =>
            expect(a2.result.current.bytes).not.toBeNull(),
        );
        const b2 = renderHook(() => useFetchDocxBytes("evict-doc", "v2"));
        await waitFor(() =>
            expect(b2.result.current.bytes).not.toBeNull(),
        );
        expect(fetchCount).toBe(4);
    });
});

describe("useFetchDocxBytes: in-flight dedupe", () => {
    it("two simultaneous mounts of the same key share one network request", async () => {
        // We hold the response open with a deferred until both hooks
        // have mounted.  The SUT keeps a single Promise in `inFlight`
        // keyed by (doc, version, refetchKey) so the second mount
        // joins the in-flight call instead of starting its own.
        let fetchCount = 0;
        let resolve!: () => void;
        const gate = new Promise<void>((r) => {
            resolve = r;
        });

        server.use(
            http.get("*/api/single-documents/:id/docx", async () => {
                fetchCount += 1;
                await gate;
                return new HttpResponse(new Uint8Array([0xff]));
            }),
        );

        const a = renderHook(() => useFetchDocxBytes("dedupe-doc"));
        const b = renderHook(() => useFetchDocxBytes("dedupe-doc"));

        // Both hooks are now loading.  Release the deferred.
        resolve();

        await waitFor(() => {
            expect(a.result.current.bytes).not.toBeNull();
            expect(b.result.current.bytes).not.toBeNull();
        });

        // Only one fetch was made.
        expect(fetchCount).toBe(1);
    });
});

describe("useFetchDocxBytes: documentId transitions to null", () => {
    it("clears bytes + downloadUrl when documentId is set to null", async () => {
        server.use(
            http.get("*/api/single-documents/:id/docx", () =>
                new HttpResponse(new Uint8Array([0xab])),
            ),
        );

        const { result, rerender } = renderHook(
            ({ id }: { id: string | null }) => useFetchDocxBytes(id),
            { initialProps: { id: "d1" as string | null } },
        );
        await waitFor(() => expect(result.current.bytes).not.toBeNull());

        rerender({ id: null });

        expect(result.current.bytes).toBeNull();
        expect(result.current.downloadUrl).toBeNull();
    });
});
