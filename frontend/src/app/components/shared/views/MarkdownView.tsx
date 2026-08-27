"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getAuthToken } from "@/app/lib/auth";

interface Props {
    documentId: string;
    versionId?: string | null;
}

export function MarkdownView({ documentId, versionId }: Props) {
    const [text, setText] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setText(null);

        let cancelled = false;

        (async () => {
            try {
                const token = await getAuthToken();
                if (cancelled) return;

                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
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
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = await response.text();
                if (!cancelled) setText(body);
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

    return (
        <div className="flex-1 overflow-auto px-3 pt-5 pb-3">
            {loading && (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            )}
            {error && (
                <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-red-500">{error}</p>
                </div>
            )}
            {text !== null && (
                <div className="mx-auto max-w-3xl text-gray-900 text-base prose prose-sm max-w-none font-serif">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {text}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    );
}
