"use client";

import { useEffect, useRef, useState } from "react";
import {
    getBrowserAccessToken,
    bounceIfUnauthorized,
} from "@/app/lib/auth-token";

/**
 * /display returns PDF bytes (when the active version has a PDF rendition),
 * raw spreadsheet bytes (xlsx/xlsm/xls — never converted to PDF), or raw DOCX
 * bytes otherwise. Reporting the type lets the caller swap between PdfView
 * (PDF.js), SpreadsheetView (Fortune-sheet), and DocxView (docx-preview).
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

/** Office spreadsheet content types served raw by /display. */
function isSpreadsheetContentType(contentType: string): boolean {
    return (
        contentType.includes("spreadsheetml") || // .xlsx
        contentType.includes("ms-excel") // .xls / .xlsm
    );
}

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                // Upstream divergence (OSS-6, auth-fetch): token from
                // auth-token (Entra/local/Supabase), `/api` prefix, and a
                // 401 bounce, instead of supabase.auth.getSession().
                const token = await getBrowserAccessToken();
                if (cancelled) return;

                const apiBase =
                    (process.env.NEXT_PUBLIC_API_BASE_URL ??
                        "http://localhost:3001") + "/api";
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                bounceIfUnauthorized(response);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType =
                    response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else if (isSpreadsheetContentType(contentType)) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "spreadsheet", buffer });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to PDF/spreadsheet viewers. Callers
                    // should route DOC/DOCX files to DocxView directly.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
