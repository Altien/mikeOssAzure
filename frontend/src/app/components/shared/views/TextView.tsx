"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { withoutMarkdownNode } from "../../assistant/message/messageStyles";
import { viewRoundingClass, type ViewRounding } from "./viewRounding";

/**
 * A stored text document (an imported email's Markdown, a written note) shown
 * from its source bytes. Markdown is rendered without raw HTML or images, so
 * nothing in it is fetched; every other text format is shown as written.
 */
export function TextView({
    documentId,
    versionId,
    filename,
    refetchKey,
    displayUrl,
    rounded = true,
}: {
    documentId: string;
    versionId?: string | null;
    filename: string;
    refetchKey?: number | string;
    /** The caller's source URL in place of /file (workflow add-on assets). */
    displayUrl?: string | null;
    rounded?: ViewRounding;
}) {
    // Uncached, like the spreadsheet view: a replaced version must reload.
    const { bytes, error } = useFetchDocxBytes(documentId, versionId, refetchKey, displayUrl, false);
    const text = useMemo(
        () => (bytes ? new TextDecoder().decode(bytes) : null),
        [bytes],
    );
    const isMarkdown = /\.(md|markdown)$/i.test(filename);
    const roundingClass = viewRoundingClass(rounded);
    const frameClass = `relative flex flex-1 min-h-0 flex-col overflow-auto bg-white ${roundingClass}`;

    if (error) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    Failed to load document.
                </div>
            </div>
        );
    }
    if (text === null) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            </div>
        );
    }
    return (
        <div className={frameClass}>
            {isMarkdown ? (
                <div className="prose prose-sm max-w-none px-8 py-6 text-gray-900">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        disallowedElements={["img"]}
                        unwrapDisallowed
                        components={{
                            a: (props) => (
                                <a
                                    {...withoutMarkdownNode(props)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                />
                            ),
                        }}
                    >
                        {text}
                    </ReactMarkdown>
                </div>
            ) : (
                <pre className="whitespace-pre-wrap break-words px-8 py-6 font-mono text-sm text-gray-900">
                    {text}
                </pre>
            )}
        </div>
    );
}
