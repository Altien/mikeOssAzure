"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Loader2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";
import type {
    PanelDocument,
    PanelDocumentQuote,
    PanelSubdocument,
} from "../shared/types";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
    QUOTE_HIGHLIGHT_CLASS,
} from "../shared/views/highlightDocxQuote";

const CASE_HTML_SANITIZER_CONFIG = {
    ALLOWED_TAGS: [
        "a",
        "blockquote",
        "br",
        "code",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "i",
        "li",
        "ol",
        "p",
        "pre",
        "small",
        "span",
        "strong",
        "sub",
        "sup",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
    ],
    ALLOWED_ATTR: [
        "aria-label",
        "class",
        "colspan",
        "href",
        "id",
        "rel",
        "rowspan",
        "target",
        "title",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#)/i,
    FORBID_ATTR: ["style"],
    FORBID_TAGS: [
        "embed",
        "form",
        "iframe",
        "math",
        "object",
        "script",
        "style",
        "svg",
    ],
    RETURN_TRUSTED_TYPE: false,
};

function sanitizeCaseHtml(value: string): string {
    const sanitized = DOMPurify.sanitize(value, CASE_HTML_SANITIZER_CONFIG);
    if (typeof document === "undefined") return sanitized;

    const template = document.createElement("template");
    template.innerHTML = sanitized;
    template.content.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.getAttribute("href") ?? "";
        if (href.startsWith("#")) return;
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
    });
    return template.innerHTML;
}

export function CaseView({
    document,
    activeQuote,
    quoteFocusKey,
    isLoading = false,
    error = null,
    onRetry,
    onClearQuote,
}: {
    document: PanelDocument;
    activeQuote?: PanelDocumentQuote | null;
    quoteFocusKey?: number;
    isLoading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    onClearQuote?: () => void;
}) {
    const subdocuments = useMemo(
        () => document.subdocuments ?? [],
        [document.subdocuments],
    );
    const [activeSubdocumentId, setActiveSubdocumentId] = useState<
        string | null
    >(
        activeQuote?.target.subdocument_id ??
            subdocuments[0]?.document_id ??
            null,
    );
    const contentRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the first opinion when a new document is supplied
        setActiveSubdocumentId(subdocuments[0]?.document_id ?? null);
    }, [document.document_id, subdocuments]);

    useEffect(() => {
        const targetId = activeQuote?.target.subdocument_id;
        if (targetId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- selected quotes control the visible opinion
            setActiveSubdocumentId(targetId);
        }
    }, [activeQuote?.target.subdocument_id, subdocuments]);

    const activeSubdocument =
        subdocuments.find(
            (subdocument) => subdocument.document_id === activeSubdocumentId,
        ) ?? subdocuments[0];

    useEffect(() => {
        const root = contentRef.current;
        if (!root) return;
        clearDocxQuoteHighlights(root);
        if (!activeQuote) return;
        if (
            activeQuote.target.subdocument_id &&
            activeQuote.target.subdocument_id !== activeSubdocument?.document_id
        ) {
            return;
        }
        const match = highlightDocxQuote(root, activeQuote.quote);
        if (!match) return;
        root.querySelectorAll(`.${QUOTE_HIGHLIGHT_CLASS}`).forEach((element) =>
            element.classList.add("case-quote-highlight"),
        );
        window.setTimeout(() => {
            match.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
    }, [activeQuote, activeSubdocument, quoteFocusKey]);

    const surfaceClassName = "bg-white/60 backdrop-blur-xl";
    const visibleLoading = isLoading && subdocuments.length === 0;
    const visibleError = subdocuments.length === 0 ? error : null;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {!visibleLoading && !visibleError && subdocuments.length > 1 && (
                <div className="relative px-1 shadow-[inset_0_-1px_0_rgb(229_231_235)]">
                    <div className="relative z-10 flex items-end gap-1 overflow-hidden px-2 pt-1">
                        {subdocuments.map((subdocument) => {
                            const isActive =
                                subdocument.document_id ===
                                activeSubdocument?.document_id;
                            return (
                                <button
                                    key={subdocument.document_id}
                                    type="button"
                                    onClick={() => {
                                        setActiveSubdocumentId(
                                            subdocument.document_id,
                                        );
                                        onClearQuote?.();
                                    }}
                                    style={
                                        isActive
                                            ? {
                                                  filter: "drop-shadow(0 -1px 0 #e5e7eb) drop-shadow(-1px 0 0 #e5e7eb) drop-shadow(1px 0 0 #e5e7eb)",
                                              }
                                            : undefined
                                    }
                                    className={`group relative flex h-8 max-w-[180px] shrink-0 items-center rounded-t-lg px-3 font-serif text-[13px] transition-colors ${
                                        isActive
                                            ? "z-20 bg-white text-gray-800 before:content-[''] before:absolute before:bottom-0 before:-left-2 before:z-20 before:h-2 before:w-2 before:rounded-br-lg before:shadow-[4px_4px_0_4px_white] before:transition-shadow after:content-[''] after:absolute after:bottom-0 after:-right-2 after:z-20 after:h-2 after:w-2 after:rounded-bl-lg after:shadow-[-4px_4px_0_4px_white] after:transition-shadow"
                                            : "z-10 bg-gray-100 text-gray-600 hover:bg-gray-100 before:content-[''] before:absolute before:bottom-0 before:-left-2 before:h-2 before:w-2 before:rounded-br-lg before:shadow-[4px_4px_0_4px_#f3f4f6] before:transition-shadow after:content-[''] after:absolute after:bottom-0 after:-right-2 after:h-2 after:w-2 after:rounded-bl-lg after:shadow-[-4px_4px_0_4px_#f3f4f6] after:transition-shadow"
                                    }`}
                                >
                                    <span className="truncate">
                                        {subdocument.title}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col">
                {visibleLoading && (
                    <div className={cn("h-full min-h-0", surfaceClassName)}>
                        <div className="flex h-full items-center justify-center p-5">
                            <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                        </div>
                    </div>
                )}
                {visibleError && (
                    <div
                        className={cn(
                            "flex h-full flex-col items-center justify-center gap-3 p-4 text-center",
                            surfaceClassName,
                        )}
                    >
                        <p className="font-serif text-sm text-red-600">
                            {visibleError}
                        </p>
                        {onRetry && (
                            <PillButton tone="white" onClick={onRetry}>
                                Try again
                            </PillButton>
                        )}
                    </div>
                )}
                {!visibleLoading &&
                    !visibleError &&
                    subdocuments.length === 0 && (
                        <p
                            className={cn(
                                "p-4 font-serif text-sm text-gray-500",
                                surfaceClassName,
                            )}
                        >
                            No content was returned for this document.
                        </p>
                    )}
                {!visibleLoading && !visibleError && activeSubdocument && (
                    <div
                        className={cn(
                            "h-full min-h-0 overflow-hidden",
                            surfaceClassName,
                        )}
                    >
                        <div
                            className={cn(
                                "h-full overflow-y-auto p-5",
                                surfaceClassName,
                            )}
                        >
                            <CaseSubdocument
                                subdocument={activeSubdocument}
                                contentRef={contentRef}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function CaseSubdocument({
    subdocument,
    contentRef,
}: {
    subdocument: PanelSubdocument;
    contentRef: React.RefObject<HTMLElement | null>;
}) {
    const sanitizedHtml = useMemo(
        () => (subdocument.html ? sanitizeCaseHtml(subdocument.html) : ""),
        [subdocument.html],
    );

    return (
        <article ref={contentRef} className="case-document-content pb-6">
            <div className="mb-3">
                <h3 className="font-serif text-lg font-semibold text-gray-900">
                    {subdocument.title}
                </h3>
            </div>
            {sanitizedHtml ? (
                <div
                    className="prose prose-sm max-w-none font-serif leading-7 text-gray-900 [&_*]:font-serif [&_.case-page-number]:mx-1 [&_.case-page-number]:text-xs [&_.case-page-number]:text-gray-400 [&_a]:text-blue-600 [&_a]:underline [&_a:hover]:text-blue-700 [&_p]:my-3"
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
            ) : (
                <div className="whitespace-pre-wrap font-serif text-sm leading-7 text-gray-900 [&_p]:my-3">
                    {subdocument.text || "No document text returned."}
                </div>
            )}
        </article>
    );
}
