"use client";

import Image from "next/image";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { supabase } from "@/app/lib/supabase";
import { PillButton } from "@/app/components/ui/pill-button";
import { PdfView } from "../shared/views/PdfView";
import { DocxView } from "../shared/views/DocxView";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import {
    CitationQuotesHeader,
    type CitationQuoteHeaderItem,
} from "./CitationQuotesHeader";
import { TrackedChangeHeader } from "./TrackedChangeHeader";
import {
    cleanCitationQuoteText,
    expandCitationToEntries,
    formatCitationPage,
    formatCitationQuotePage,
    getDocumentCitationQuotes,
    isDocxFilename,
    isSpreadsheetFilename,
} from "../shared/types";
import type {
    CitationQuote,
    Citation,
    DocumentCitation,
    EditAnnotation,
} from "../shared/types";
import { quoteVerificationState } from "./message/citationVerification";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { CaseView, type CaseTab } from "./CaseView";

/**
 * Discriminated-union describing what the panel is showing above the viewer.
 *   - "document":  title row + viewer.
 *   - "citation":  title row + relevant quote + viewer.
 *   - "edit":      title row + tracked change + viewer.
 */
export type DocPanelMode =
    | { kind: "document" }
    | { kind: "citation"; citation: Citation }
    | {
          kind: "edit";
          edit: EditAnnotation;
          changeNumber?: number;
          /**
           * True while an accept/reject request for this exact edit is in
           * flight. Scoped per-edit (not per-document) so sibling edits on
           * the same doc stay clickable.
           */
          isEditReloading?: boolean;
          onResolveStart?: (args: {
              editId: string;
              documentId: string;
              verb: "accept" | "reject";
          }) => void;
          onResolved?: (args: {
              editId: string;
              documentId: string;
              status: "accepted" | "rejected";
              versionId: string | null;
              downloadUrl: string | null;
          }) => void;
          onError?: (args: {
              editId: string;
              documentId: string;
              versionId: string | null;
              message: string;
          }) => void;
      };

interface DocumentPanelProps {
    kind: "document";
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    mode: DocPanelMode;
    /** Spinner on the Download button while an accept/reject is in flight. */
    isReloading?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
}

interface CasePanelProps {
    kind: "case";
    tab: CaseTab;
    compactActions?: boolean;
}

type Props = DocumentPanelProps | CasePanelProps;

/**
 * Unified side-panel body for documents and legal sources. The shell owns
 * the title, metadata, and source actions; each source-specific view owns
 * fetching, selection, and highlighting within its content.
 */
export function DocPanel(props: Props) {
    if (props.kind === "case") {
        return (
            <CasePanel
                tab={props.tab}
                compactActions={props.compactActions ?? false}
            />
        );
    }
    return <DocumentPanel {...props} />;
}

function DocumentPanel({
    documentId,
    filename,
    versionId,
    versionNumber,
    mode,
    isReloading = false,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
}: DocumentPanelProps) {
    // Pick the viewer from the filename only, not from mode. Switching
    // headers (citation ↔ edit ↔ document) for the same document must
    // not unmount and remount the body — otherwise the user sees a full
    // re-fetch every time they toggle. Tracked-change rendering still
    // only lives in DocxView, which is fine because edits are DOCX-only.
    const useDocxView = isDocxFilename(filename);
    const useSheetView = isSpreadsheetFilename(filename);
    const firstCitationQuote =
        mode.kind === "citation"
            ? getDocumentCitationQuotes(mode.citation)[0]
            : undefined;
    const citationQuoteId =
        mode.kind === "citation" &&
        firstCitationQuote &&
        quoteVerificationState(firstCitationQuote) !== "unverified"
            ? `document:${mode.citation.ref}:0`
            : null;
    const [activeCitationQuoteId, setActiveCitationQuoteId] = useState<
        string | null
    >(citationQuoteId);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const [editFocusKey, setEditFocusKey] = useState(0);

    const quotes: CitationQuote[] | undefined = useMemo(() => {
        if (mode.kind !== "citation") return undefined;
        if (!activeCitationQuoteId) return [];
        const selectedIndex = Number(activeCitationQuoteId.split(":").at(-1));
        if (!Number.isFinite(selectedIndex)) return [];
        const selectedQuote =
            getDocumentCitationQuotes(mode.citation)[selectedIndex];
        if (!selectedQuote) return [];
        const documentCitation = mode.citation as DocumentCitation;
        return expandCitationToEntries({
            ...documentCitation,
            page: selectedQuote.page,
            quote: selectedQuote.quote,
            quotes: [selectedQuote],
        });
    }, [activeCitationQuoteId, mode]);

    // Cell locator(s) for the selected quote, used to highlight the cited cell
    // when the document is a spreadsheet.
    const highlightCells = useMemo(() => {
        if (mode.kind !== "citation") return undefined;
        if (!activeCitationQuoteId) return [];
        const selectedIndex = Number(activeCitationQuoteId.split(":").at(-1));
        if (!Number.isFinite(selectedIndex)) return [];
        const selectedQuote =
            getDocumentCitationQuotes(mode.citation)[selectedIndex];
        if (!selectedQuote || (!selectedQuote.cell && !selectedQuote.sheet))
            return [];
        return [{ sheet: selectedQuote.sheet, cell: selectedQuote.cell }];
    }, [activeCitationQuoteId, mode]);

    useEffect(() => {
        setActiveCitationQuoteId(citationQuoteId);
    }, [citationQuoteId]);

    const handleCitationQuoteSelect = useCallback(
        (quoteId: string) => {
            const shouldSelect = activeCitationQuoteId !== quoteId;
            setActiveCitationQuoteId(shouldSelect ? quoteId : null);
            if (shouldSelect) setQuoteFocusKey((current) => current + 1);
        },
        [activeCitationQuoteId],
    );

    const highlightEdit = useMemo(() => {
        if (mode.kind !== "edit") return null;
        return {
            key: `${mode.edit.edit_id}:${editFocusKey}`,
            inserted_text: mode.edit.inserted_text,
            deleted_text: mode.edit.deleted_text,
            ins_w_id: mode.edit.ins_w_id ?? null,
            del_w_id: mode.edit.del_w_id ?? null,
        };
    }, [editFocusKey, mode]);

    return (
        <div className="flex h-full flex-col">
            <DocumentTitleRow
                documentId={documentId}
                filename={filename}
                versionId={versionId}
                versionNumber={versionNumber}
                isReloading={isReloading}
            />

            {mode.kind === "citation" && (
                <RelevantQuoteSection
                    citation={mode.citation}
                    filename={filename}
                    activeQuoteId={activeCitationQuoteId}
                    onQuoteSelect={handleCitationQuoteSelect}
                />
            )}

            {mode.kind === "edit" && (
                <TrackedChangeHeader
                    edit={mode.edit}
                    changeNumber={mode.changeNumber}
                    isEditReloading={mode.isEditReloading}
                    onResolveStart={mode.onResolveStart}
                    onResolved={mode.onResolved}
                    onError={mode.onError}
                    onHighlight={() => setEditFocusKey((current) => current + 1)}
                />
            )}

            <div className="flex flex-1 min-h-0 flex-col">
                {useDocxView ? (
                    <DocxView
                        documentId={documentId}
                        versionId={versionId ?? undefined}
                        rounded={false}
                        quotes={quotes}
                        quoteFocusKey={quoteFocusKey}
                        highlightEdit={highlightEdit}
                        warning={warning ?? null}
                        onWarningDismiss={onWarningDismiss}
                        initialScrollTop={initialScrollTop ?? null}
                        onScrollChange={onScrollChange}
                    />
                ) : useSheetView ? (
                    <SpreadsheetView
                        documentId={documentId}
                        versionId={versionId}
                        rounded={false}
                        highlightCells={highlightCells}
                    />
                ) : (
                    <PdfView
                        doc={{
                            document_id: documentId,
                            version_id: versionId,
                        }}
                        rounded={false}
                        quotes={quotes}
                        quoteFocusKey={quoteFocusKey}
                    />
                )}
            </div>
        </div>
    );
}

function CasePanel({
    tab,
    compactActions,
}: {
    tab: CaseTab;
    compactActions: boolean;
}) {
    const title =
        [tab.caseName, tab.citation].filter(Boolean).join(", ") || "Case";
    const filedDate = formatCaseDate(tab.dateFiled);
    const metadata = filedDate
        ? [{ label: "Date", value: filedDate }]
        : [];

    return (
        <div className="flex h-full flex-col">
            <PanelTitleRow
                icon={
                    <Image
                        src="/icons/legal-sources/case-law.svg"
                        alt=""
                        aria-hidden="true"
                        width={16}
                        height={16}
                        className="h-4 w-4 shrink-0 object-contain"
                    />
                }
                title={title}
                metadata={metadata}
                downloadUrl={tab.pdfUrl}
                externalLink={
                    tab.url
                        ? {
                              href: tab.url,
                              label: "CourtListener",
                              title: "Open in CourtListener",
                          }
                        : null
                }
                compactActions={compactActions}
            />
            <CaseView tab={tab} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Shared source header
// ---------------------------------------------------------------------------

type PanelMetadataItem = {
    label?: string;
    value: string;
};

type ExternalSourceLink = {
    href: string;
    label: string;
    title: string;
};

function PanelTitleRow({
    icon,
    title,
    badge,
    metadata = [],
    downloadButton,
    downloadUrl,
    externalLink,
    compactActions = false,
}: {
    icon: ReactNode;
    title: string;
    badge?: ReactNode;
    metadata?: PanelMetadataItem[];
    downloadButton?: ReactNode;
    downloadUrl?: string | null;
    externalLink?: ExternalSourceLink | null;
    compactActions?: boolean;
}) {
    return (
        <div className="p-3">
            <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="mt-0.5 shrink-0">{icon}</span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <h2
                            className="min-w-0 break-words text-sm font-medium text-gray-800"
                            title={title}
                        >
                            {title}
                        </h2>
                        {badge}
                    </div>
                </div>
                {(downloadButton || downloadUrl || externalLink) && (
                    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
                        {downloadButton}
                        {downloadUrl && (
                            <UrlDownloadButton
                                href={downloadUrl}
                                compact={compactActions}
                            />
                        )}
                        {externalLink && (
                            <ExternalSourceLinkButton
                                link={externalLink}
                                compact={compactActions}
                            />
                        )}
                    </div>
                )}
            </div>
            {metadata.length > 0 && (
                <div className="mt-1 flex w-full flex-wrap items-center gap-x-3 gap-y-1 font-serif text-sm text-gray-600">
                    {metadata.map((item, index) => (
                        <span
                            key={`${item.label ?? "metadata"}:${item.value}:${index}`}
                        >
                            {item.label ? `${item.label}: ` : ""}
                            {item.value}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

export function DocumentTitleRow({
    documentId,
    filename,
    versionId,
    versionNumber,
    isReloading,
}: {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    isReloading: boolean;
}) {
    return (
        <PanelTitleRow
            icon={<FileTypeIcon fileType={filename} className="h-4 w-4" />}
            title={filename}
            badge={
                versionNumber && versionNumber > 0 ? (
                    <span className="inline-flex shrink-0 items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                        V{versionNumber}
                    </span>
                ) : null
            }
            downloadButton={
                <DownloadButton
                    documentId={documentId}
                    versionId={versionId}
                    filename={filename}
                    isReloading={isReloading}
                />
            }
        />
    );
}

function RelevantQuoteSection({
    citation,
    filename,
    activeQuoteId,
    onQuoteSelect,
}: {
    citation: Citation;
    filename: string;
    activeQuoteId: string | null;
    onQuoteSelect: (quoteId: string) => void;
}) {
    const citationQuotes = getDocumentCitationQuotes(citation);
    const pagesLabel = formatCitationPage(citation);
    const citationText = [filename, pagesLabel].filter(Boolean).join(", ");
    const relevantQuotes: CitationQuoteHeaderItem[] = citationQuotes.map(
        (quote, index) => {
            const pageLabel = formatCitationQuotePage(
                citation,
                quote.page,
                quote,
            );
            return {
                id: `document:${citation.ref}:${index}`,
                quote: cleanCitationQuoteText(citation, quote.quote),
                inlineDetail: pageLabel || null,
                citationText: [filename, pageLabel].filter(Boolean).join(", "),
                verificationState: quoteVerificationState(quote),
            };
        },
    );
    const currentIndex = Math.max(
        0,
        relevantQuotes.findIndex((quote) => quote.id === activeQuoteId),
    );

    return (
        <CitationQuotesHeader
            quotes={relevantQuotes}
            activeQuoteId={activeQuoteId}
            currentIndex={currentIndex}
            citationRef={citation.ref}
            citationText={citationText}
            onSelect={(quote) => {
                if (quote.verificationState !== "unverified") {
                    onQuoteSelect(quote.id);
                }
            }}
            onIndexChange={(index) => {
                const quote = relevantQuotes[index];
                if (quote && quote.verificationState !== "unverified") {
                    onQuoteSelect(quote.id);
                }
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// Source actions
// ---------------------------------------------------------------------------

function formatCaseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00Z`)
        : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function UrlDownloadButton({
    href,
    compact,
}: {
    href: string;
    compact: boolean;
}) {
    return (
        <PillButton
            asChild
            tone="white"
            className={compact ? "h-8 w-8 px-0 py-0" : undefined}
        >
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                download
                aria-label="Download"
                title="Download"
            >
                <Download className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>
                    Download
                </span>
            </a>
        </PillButton>
    );
}

function ExternalSourceLinkButton({
    link,
    compact,
}: {
    link: ExternalSourceLink;
    compact: boolean;
}) {
    return (
        <PillButton
            asChild
            tone="white"
            className={compact ? "h-8 w-8 px-0 py-0" : undefined}
        >
            <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={link.title}
                title={link.title}
            >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>
                    {link.label}
                </span>
            </a>
        </PillButton>
    );
}

function DownloadButton({
    documentId,
    versionId,
    filename,
    isReloading,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading?: boolean;
}) {
    const [busy, setBusy] = useState(false);

    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            const qs = versionId
                ? `?version_id=${encodeURIComponent(versionId)}`
                : "";
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/docx${qs}`,
                {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                },
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } finally {
            setBusy(false);
        }
    };

    const spinning = busy || isReloading;
    return (
        <PillButton tone="white" onClick={handleClick} disabled={spinning}>
            {spinning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Download className="h-3.5 w-3.5" />
            )}
            Download
        </PillButton>
    );
}
