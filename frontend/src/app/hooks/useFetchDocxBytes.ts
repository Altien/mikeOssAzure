"use client";

import { useEffect, useState } from "react";
import { getDocumentFileUrl } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";

export interface FetchDocxResult {
    bytes: ArrayBuffer | null;
    loading: boolean;
    error: string | null;
}

// Module-level cache keyed by `${documentId}:${versionId}:${refetchKey}`.
// The same cache is shared across every hook instance so tab switches
// (which remount new DocxView subtrees or re-run the effect because of an
// unstable prop upstream) don't cause a refetch as long as the tuple is
// unchanged. Promises are cached too, so concurrent mounts for the same
// key share a single in-flight request.
const bytesCache = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();

function cacheKey(
    documentId: string,
    versionId?: string | null,
    refetchKey?: number,
    sourceUrl?: string | null,
): string {
    return `${sourceUrl ?? documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
}

/**
 * Fetch the raw .docx bytes for a document, optionally targeting a specific
 * tracked-changes version. Results are cached so the DocxView can re-render
 * cheaply when switching between versions, and tab switches don't refetch.
 */
export function useFetchDocxBytes(
    documentId: string | null | undefined,
    versionId?: string | null,
    refetchKey?: number,
    sourceUrl?: string | null,
): FetchDocxResult {
    const initialKey = documentId
        ? cacheKey(documentId, versionId, refetchKey, sourceUrl)
        : null;
    const [bytes, setBytes] = useState<ArrayBuffer | null>(
        initialKey ? (bytesCache.get(initialKey) ?? null) : null,
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!documentId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale bytes when documentId is removed, within the fetch effect
            setBytes(null);
            return;
        }

        const key = cacheKey(documentId, versionId, refetchKey, sourceUrl);
        const url = sourceUrl ?? getDocumentFileUrl(documentId, versionId);

        // Cache hit: reuse bytes synchronously, no network, no spinner.
        const cached = bytesCache.get(key);
        if (cached) {
            setBytes(cached);
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);

        const pending =
            inFlight.get(key) ??
            (async () => {
                // The private source bytes are streamed through the same-origin
                // authenticated API, including Word/web cookie sessions.
                const bin = await authenticatedFetch(url);
                if (!bin.ok) throw new Error(`HTTP ${bin.status}`);
                const buf = await bin.arrayBuffer();
                bytesCache.set(key, buf);
                return buf;
            })();
        if (!inFlight.has(key)) inFlight.set(key, pending);

        pending
            .then((buf) => {
                if (cancelled) return;
                setBytes(buf);
            })
            .catch(() => {
                if (cancelled) return;
                setError(
                    "This document could not be loaded. Please try again.",
                );
            })
            .finally(() => {
                inFlight.delete(key);
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [documentId, versionId, refetchKey, sourceUrl]);

    return { bytes, loading, error };
}

/**
 * Evict cache entries for a given document (e.g. after accept/reject
 * writes new bytes at the same storage path, or the user uploads a new
 * version). Pass a versionId to scope eviction; omit to clear every
 * cached version for that document.
 */
export function invalidateDocxBytes(
    documentId: string,
    versionId?: string | null,
): void {
    if (versionId !== undefined) {
        for (const key of Array.from(bytesCache.keys())) {
            if (key.startsWith(`${documentId}:${versionId ?? ""}:`)) {
                bytesCache.delete(key);
            }
        }
        return;
    }
    for (const key of Array.from(bytesCache.keys())) {
        if (key.startsWith(`${documentId}:`)) bytesCache.delete(key);
    }
}
