"use client";

import { useCallback, useEffect, useState } from "react";
import { getPanelDocument } from "@/app/lib/mikeApi";
import type { PanelDocument } from "../shared/types";

function mergePanelDocuments(
    summary: PanelDocument,
    loaded: PanelDocument,
): PanelDocument {
    return {
        ...loaded,
        title:
            summary.title && summary.title !== "Case"
                ? summary.title
                : loaded.title,
        metadata: summary.metadata.length ? summary.metadata : loaded.metadata,
        actions: summary.actions?.length ? summary.actions : loaded.actions,
        quotes: summary.quotes.length ? summary.quotes : loaded.quotes,
    };
}

function friendlyDocumentError(message: string): string {
    try {
        const parsed = JSON.parse(message) as { detail?: unknown };
        if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
        // Keep the original message.
    }
    if (message.includes("429") || /rate limit|throttled/i.test(message)) {
        const wait = message.match(/available in\s+(\d+)\s+seconds/i)?.[1];
        return wait
            ? `This source is temporarily rate limited. Please try again in about ${wait} seconds.`
            : "This source is temporarily rate limited. Please try again shortly.";
    }
    return "Could not load this document. Please try again shortly.";
}

export function useResolvedPanelDocument(document: PanelDocument): {
    document: PanelDocument;
    isLoading: boolean;
    error: string | null;
    retry: () => void;
} {
    const [resolvedDocument, setResolvedDocument] =
        useState<PanelDocument>(document);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [requestVersion, setRequestVersion] = useState(0);

    const retry = useCallback(() => {
        setRequestVersion((current) => current + 1);
    }, []);

    useEffect(() => {
        const needsHydration =
            document.type === "case" && !document.subdocuments?.length;
        if (!needsHydration) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize a new panel input before rendering its viewer
            setResolvedDocument(document);
            setIsLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setResolvedDocument(document);
        setIsLoading(true);
        setError(null);
        void getPanelDocument(document.document_id)
            .then((loaded) => {
                if (!cancelled) {
                    setResolvedDocument(mergePanelDocuments(document, loaded));
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setError(
                        reason instanceof Error
                            ? friendlyDocumentError(reason.message)
                            : "Could not load this document.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [document, requestVersion]);

    return { document: resolvedDocument, isLoading, error, retry };
}
