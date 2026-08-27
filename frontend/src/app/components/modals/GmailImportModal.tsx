"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail, Paperclip } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
    getGmailMessage,
    importGmailMessage,
    searchGmailMessages,
    type GmailMessageDetail,
    type GmailMessageSummary,
} from "@/app/lib/mikeApi";
import type { Document } from "../shared/types";
import { Modal } from "./Modal";

interface Props {
    open: boolean;
    onClose: () => void;
    onImported: (document: Document) => void;
    projectId?: string | null;
}

function displayDate(value: string | null): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

export function GmailImportModal({
    open,
    onClose,
    onImported,
    projectId = null,
}: Props) {
    const [query, setQuery] = useState("");
    const [messages, setMessages] = useState<GmailMessageSummary[]>([]);
    const [selected, setSelected] = useState<GmailMessageDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setSelected(null);
        setError(null);
    }, [open]);

    useEffect(() => {
        if (!open || selected) return;
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            searchGmailMessages({ query, maxResults: 25 })
                .then((result) => {
                    if (!cancelled) {
                        setMessages(result.messages);
                        setError(null);
                    }
                })
                .catch((cause) => {
                    if (!cancelled) {
                        setMessages([]);
                        setError(cause instanceof Error ? cause.message : "Gmail search failed.");
                    }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, query, selected]);

    async function chooseMessage(message: GmailMessageSummary) {
        setDetailLoading(true);
        setError(null);
        try {
            setSelected(await getGmailMessage(message.id));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not load the email.");
        } finally {
            setDetailLoading(false);
        }
    }

    async function handleImport() {
        if (!selected || importing) return;
        setImporting(true);
        setError(null);
        try {
            const document = await importGmailMessage({
                messageId: selected.id,
                projectId,
            });
            onImported(document);
            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not import the email.");
        } finally {
            setImporting(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Import from Gmail"]}
            size="lg"
            footerStatus={error ? <span className="text-xs text-red-600">{error}</span> : undefined}
            secondaryAction={selected ? { label: "Back to results", onClick: () => setSelected(null), disabled: importing } : undefined}
            primaryAction={selected ? {
                label: importing ? "Importing..." : "Import email",
                onClick: handleImport,
                disabled: importing,
                icon: importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined,
            } : undefined}
        >
            {selected ? (
                <div className="flex min-h-0 flex-1 flex-col gap-4 py-2">
                    <div className="space-y-1 border-b border-gray-100 pb-4">
                        <div className="flex items-start gap-2">
                            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                            <p className="min-w-0 text-sm font-medium text-gray-900">{selected.subject}</p>
                        </div>
                        <p className="pl-6 text-xs text-gray-500">From: {selected.from || "Unknown sender"}</p>
                        <p className="pl-6 text-xs text-gray-500">To: {selected.to || "Unknown recipient"}</p>
                        <p className="pl-6 text-xs text-gray-400">{displayDate(selected.date)}</p>
                    </div>
                    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-gray-700">
                        {selected.body || selected.snippet || "This email has no text body."}
                    </div>
                    {selected.attachments.length > 0 && (
                        <div className="border-t border-gray-100 pt-3">
                            <p className="mb-2 text-xs font-medium uppercase text-gray-400">Referenced attachments</p>
                            {selected.attachments.map((attachment, index) => (
                                <p key={`${attachment.filename}-${index}`} className="flex items-center gap-2 text-xs text-gray-600">
                                    <Paperclip className="h-3.5 w-3.5" />
                                    {attachment.filename}
                                </p>
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-3 py-2">
                    <SearchBar
                        value={query}
                        onValueChange={setQuery}
                        placeholder='Search Gmail (for example: from:client@example.com newer_than:30d)'
                    />
                    <div className="max-h-96 overflow-y-auto">
                        {loading || detailLoading ? (
                            <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {detailLoading ? "Loading email..." : "Searching Gmail..."}
                            </div>
                        ) : messages.length === 0 ? (
                            <p className="py-8 text-sm text-gray-500">No email found.</p>
                        ) : messages.map((message) => (
                            <button
                                key={message.id}
                                type="button"
                                onClick={() => void chooseMessage(message)}
                                className="flex w-full items-start gap-2.5 border-b border-gray-100 px-2 py-3 text-left transition-colors last:border-0 hover:bg-gray-50"
                            >
                                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className="truncate text-sm font-medium text-gray-900">{message.subject}</span>
                                        {message.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-gray-400" />}
                                    </span>
                                    <span className="block truncate text-xs text-gray-500">{message.from}</span>
                                    <span className="mt-0.5 block truncate text-xs text-gray-400">{message.snippet}</span>
                                </span>
                                <span className="shrink-0 text-xs text-gray-400">{displayDate(message.date)}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </Modal>
    );
}
