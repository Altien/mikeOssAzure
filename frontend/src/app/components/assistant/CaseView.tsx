"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type RefObject,
} from "react";
import DOMPurify from "dompurify";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import type { CaseCitationQuote } from "../shared/types";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
} from "../shared/views/highlightDocxQuote";
import {
    CitationQuotesHeader,
    type CitationQuoteHeaderItem,
} from "./CitationQuotesHeader";
import {
    getCourtlistenerOpinions,
    type CaseLawOpinion,
} from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

export type CaseTab = {
    kind: "case";
    id: `case:${number}`;
    chatId: string;
    clusterId: number;
    citationRef?: number;
    caseName: string | null;
    citation: string | null;
    url: string | null;
    dateFiled: string | null;
    pdfUrl: string | null;
    quotes?: CaseCitationQuote[];
    opinions?: CaseLawOpinion[];
};

const courtlistenerOpinionsCache = new Map<number, CaseLawOpinion[]>();
const caseOpinionsRequestCache = new Map<
    string,
    ReturnType<typeof getCourtlistenerOpinions>
>();

const CASE_OPINION_SANITIZER_CONFIG = {
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
    ALLOWED_URI_REGEXP: /^(?:https:\/\/www\.courtlistener\.com\/|#)/i,
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

function sanitizeCaseOpinionHtml(value: string): string {
    const sanitized = DOMPurify.sanitize(value, CASE_OPINION_SANITIZER_CONFIG);
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

function friendlyCaseError(message: string): string {
    try {
        const parsed = JSON.parse(message) as { detail?: unknown };
        if (typeof parsed.detail === "string") {
            message = parsed.detail;
        }
    } catch {
        /* keep original message */
    }

    if (message.includes("429") || /rate limit|throttled/i.test(message)) {
        const waitMatch = message.match(/available in\s+(\d+)\s+seconds/i);
        const wait = waitMatch?.[1];
        return wait
            ? `CourtListener is rate limiting requests. Please try again in about ${wait} seconds.`
            : "CourtListener is rate limiting requests. Please try again shortly.";
    }
    if (message.includes("401") || /credentials|token|auth/i.test(message)) {
        return "CourtListener authentication is not configured correctly.";
    }
    return "Could not load this case from CourtListener. Please try again shortly.";
}

function hashString(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

function caseTabQuoteKey(tab: CaseTab): string {
    const quoteKey =
        tab.quotes
            ?.map((quote) => quote.quote)
            .filter(Boolean)
            .join("\n---\n") ?? "";
    return [
        tab.clusterId,
        tab.citationRef ?? "source",
        hashString(quoteKey),
    ].join(":");
}

function relevantQuoteKey(quote: CaseCitationQuote, index: number): string {
    return `${quote.opinionId ?? "unknown"}:${index}:${hashString(quote.quote)}`;
}

function caseCitationRequestKey(tab: CaseTab) {
    return String(tab.clusterId);
}

export function CaseView({ tab }: { tab: CaseTab }) {
    const cachedOpinions = courtlistenerOpinionsCache.get(tab.clusterId);
    const [opinions, setOpinions] = useState<CaseLawOpinion[]>(
        tab.opinions?.length ? tab.opinions : (cachedOpinions ?? []),
    );
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [activeOpinionId, setActiveOpinionId] = useState<number | null>(null);
    const [relevantQuotes, setRelevantQuotes] = useState<CaseCitationQuote[]>(
        tab.quotes ?? [],
    );
    const [activeQuoteKey, setActiveQuoteKey] = useState<string | null>(null);
    const [quoteIndexState, setQuoteIndexState] = useState({
        cacheKey: "",
        index: 0,
    });
    const opinionScrollRef = useRef<HTMLDivElement | null>(null);
    const opinionContentRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (tab.opinions?.length) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- sync path of an async fetch effect: serve prop/cache data without a loading flash
            setOpinions(tab.opinions);
            setLoading(false);
            setError(null);
            return;
        }
        const cached = courtlistenerOpinionsCache.get(tab.clusterId);
        if (cached?.length) {
            setOpinions(cached);
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);
        const requestKey = caseCitationRequestKey(tab);
        let request = caseOpinionsRequestCache.get(requestKey);
        if (!request) {
            request = getCourtlistenerOpinions(tab.clusterId).finally(() => {
                caseOpinionsRequestCache.delete(requestKey);
            });
            caseOpinionsRequestCache.set(requestKey, request);
        }
        request
            .then((nextOpinions) => {
                if (!cancelled) {
                    setOpinions(nextOpinions);
                    courtlistenerOpinionsCache.set(tab.clusterId, nextOpinions);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? friendlyCaseError(err.message)
                            : "Failed to load case",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [tab]);

    useEffect(() => {
        const firstOpinionId =
            orderOpinions(opinions).find(
                ({ opinion }) => typeof opinion.opinionId === "number",
            )?.opinion.opinionId ?? null;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset active opinion after opinions load
        setActiveOpinionId(firstOpinionId);
    }, [opinions]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- sync quote list when the tab prop changes
        setRelevantQuotes(tab.quotes ?? []);
    }, [tab.quotes]);

    const title = tab.caseName;
    const citation = tab.citation;
    const orderedOpinions = orderOpinions(opinions);
    const activeOpinion = opinions.find(
        (opinion) => opinion.opinionId === activeOpinionId,
    );
    const quoteCacheKey = caseTabQuoteKey(tab);
    const currentQuoteIndex =
        quoteIndexState.cacheKey === quoteCacheKey
            ? Math.min(
                  quoteIndexState.index,
                  Math.max(relevantQuotes.length - 1, 0),
              )
            : 0;
    const relevantQuoteItems: CitationQuoteHeaderItem[] = relevantQuotes.map(
        (quote, index) => ({
            id: relevantQuoteKey(quote, index),
            quote: quote.quote,
            eyebrow:
                quote.author || quote.type
                    ? opinionTitle({
                          opinionId: quote.opinionId,
                          type: quote.type,
                          author: quote.author,
                          url: null,
                      })
                    : null,
        }),
    );

    const selectRelevantQuote = useCallback(
        (quote: CaseCitationQuote, index: number) => {
            const key = relevantQuoteKey(quote, index);
            setQuoteIndexState({ cacheKey: quoteCacheKey, index });
            setActiveQuoteKey((current) => (current === key ? null : key));
            if (typeof quote.opinionId === "number") {
                setActiveOpinionId(quote.opinionId);
            }
        },
        [quoteCacheKey],
    );

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset quote selection when the quote set changes
        setQuoteIndexState({ cacheKey: quoteCacheKey, index: 0 });
        const firstQuote = relevantQuotes[0];
        setActiveQuoteKey(firstQuote ? relevantQuoteKey(firstQuote, 0) : null);
        if (typeof firstQuote?.opinionId === "number") {
            setActiveOpinionId(firstQuote.opinionId);
        }
    }, [quoteCacheKey, relevantQuotes]);

    useEffect(() => {
        const root = opinionContentRef.current;
        if (!root) return;
        clearDocxQuoteHighlights(root);
        if (!activeQuoteKey) return;

        const activeEntry = relevantQuotes
            .map((quote, index) => ({ quote, index }))
            .find(
                ({ quote, index }) =>
                    relevantQuoteKey(quote, index) === activeQuoteKey,
            );
        if (!activeEntry) return;
        if (
            typeof activeEntry.quote.opinionId === "number" &&
            activeEntry.quote.opinionId !== activeOpinionId
        ) {
            return;
        }

        const match = highlightDocxQuote(root, activeEntry.quote.quote);
        if (!match) return;
        window.setTimeout(() => {
            match.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
    }, [
        activeOpinionId,
        activeOpinion?.html,
        activeOpinion?.opinionId,
        activeOpinion?.text,
        activeQuoteKey,
        relevantQuotes,
    ]);

    const opinionSurfaceClassName = "bg-white/60 backdrop-blur-xl";

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {relevantQuoteItems.length > 0 && (
                <CitationQuotesHeader
                    quotes={relevantQuoteItems}
                    activeQuoteId={activeQuoteKey}
                    currentIndex={currentQuoteIndex}
                    citationRef={tab.citationRef}
                    citationText={[title, citation].filter(Boolean).join(", ")}
                    onSelect={(_quote, index) => {
                        const quote = relevantQuotes[index];
                        if (quote) selectRelevantQuote(quote, index);
                    }}
                    onIndexChange={(index) => {
                        const quote = relevantQuotes[index];
                        if (quote) selectRelevantQuote(quote, index);
                    }}
                />
            )}
            {!loading && !error && opinions.length > 1 && (
                <div className="relative px-1 shadow-[inset_0_-1px_0_rgb(229_231_235)]">
                    <div className="relative z-10 flex items-end gap-1 overflow-hidden px-2 pt-1">
                        {orderedOpinions.map(({ opinion, index }) => {
                            const opinionId = opinion.opinionId;
                            const isActive =
                                opinionId !== null &&
                                opinionId === activeOpinionId;
                            return (
                                <button
                                    key={opinionId ?? index}
                                    type="button"
                                    disabled={opinionId === null}
                                    onClick={() => {
                                        if (opinionId === null) return;
                                        setActiveOpinionId(opinionId);
                                        setActiveQuoteKey(null);
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
                                    } disabled:cursor-not-allowed disabled:opacity-50`}
                                >
                                    <span className="truncate">
                                        {opinionTitle(opinion, index)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            <div className="flex flex-1 min-h-0 flex-col">
                {loading && (
                    <div
                        className={cn(
                            "h-full min-h-0",
                            opinionSurfaceClassName,
                        )}
                    >
                        <div className="flex h-full items-center justify-center p-5">
                            <MikeIcon spin mike size={28} />
                        </div>
                    </div>
                )}
                {error && (
                    <p
                        className={cn(
                            "p-4 font-serif text-sm text-red-600",
                            opinionSurfaceClassName,
                        )}
                    >
                        {error}
                    </p>
                )}
                {!loading && !error && opinions.length === 0 && (
                    <p
                        className={cn(
                            "p-4 font-serif text-sm text-gray-500",
                            opinionSurfaceClassName,
                        )}
                    >
                        No opinions were returned for this case.
                    </p>
                )}
                {!loading && !error && opinions.length > 0 && (
                    <div
                        className={cn(
                            "h-full min-h-0 overflow-hidden",
                            opinionSurfaceClassName,
                        )}
                    >
                        {activeOpinion && (
                            <div
                                ref={opinionScrollRef}
                                className={cn(
                                    "h-full overflow-y-auto p-5",
                                    opinionSurfaceClassName,
                                )}
                            >
                                <OpinionBlock
                                    opinion={activeOpinion}
                                    contentRef={opinionContentRef}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function opinionTypeLabel(value: string | null): string {
    if (!value) return "Opinion";
    const type = value.replace(/^\d+/, "").replace(/_/g, " ").trim();
    const compactType = type.toLowerCase().replace(/\s+/g, "");
    if (compactType === "lead") return "Lead Opinion";
    if (
        compactType === "concurrentinpart" ||
        compactType === "concurrenceinpart" ||
        compactType === "concurinpart"
    ) {
        return "Concurrence in part";
    }
    if (compactType === "combined") return "Combined Opinion";
    return type.replace(/\b\w/g, (char) => char.toUpperCase());
}

function opinionOrderRank(value: string | null): number {
    const type = value?.replace(/^\d+/, "").toLowerCase() ?? "";
    if (
        type.includes("lead") ||
        type.includes("majority") ||
        type.includes("unanimous") ||
        type.includes("plurality")
    ) {
        return 0;
    }
    if (type.includes("concurr")) return 1;
    if (type.includes("dissent")) return 2;
    if (type.includes("combined")) return 4;
    return 3;
}

function orderOpinions(opinions: CaseLawOpinion[]) {
    return opinions
        .map((opinion, index) => ({ opinion, index }))
        .sort((a, b) => {
            const rankDelta =
                opinionOrderRank(a.opinion.type) -
                opinionOrderRank(b.opinion.type);
            return rankDelta || a.index - b.index;
        });
}

function opinionTitle(opinion: CaseLawOpinion, index?: number): string {
    const type = opinionTypeLabel(opinion.type);
    const fallbackType = opinion.type ? type : `Opinion ${index ?? ""}`.trim();
    return opinion.author
        ? `${fallbackType} by ${opinion.author}`
        : fallbackType;
}

function OpinionBlock({
    opinion,
    contentRef,
}: {
    opinion: CaseLawOpinion;
    contentRef?: RefObject<HTMLElement | null>;
}) {
    const sanitizedHtml = useMemo(
        () => (opinion.html ? sanitizeCaseOpinionHtml(opinion.html) : ""),
        [opinion.html],
    );

    return (
        <article
            ref={contentRef}
            className="case-opinion-content border-b border-gray-100 pb-6 last:border-b-0"
        >
            <div className="mb-3">
                <h3 className="font-serif text-lg font-semibold text-gray-900">
                    {opinionTitle(opinion)}
                </h3>
            </div>
            {sanitizedHtml ? (
                <div
                    className="prose prose-sm max-w-none font-serif leading-7 text-gray-900 [&_*]:font-serif [&_.case-page-number]:mx-1 [&_.case-page-number]:text-xs [&_.case-page-number]:text-gray-400 [&_a]:text-blue-600 [&_a]:underline [&_a:hover]:text-blue-700 [&_p]:my-3"
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
            ) : (
                <div className="whitespace-pre-wrap font-serif text-sm leading-7 text-gray-900 [&_p]:my-3">
                    {opinion.text || "No opinion text returned."}
                </div>
            )}
        </article>
    );
}
