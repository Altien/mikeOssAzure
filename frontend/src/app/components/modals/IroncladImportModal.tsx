"use client";

import { useEffect, useState } from "react";
import { Check, FileText, Loader2 } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
    getIroncladRecord,
    getIroncladStatus,
    importIroncladRecord,
    searchIroncladRecords,
    type IroncladAttachment,
    type IroncladRecordSummary,
} from "@/app/lib/mikeApi";
import type { Document } from "../shared/types";
import { Modal } from "./Modal";

interface Props {
    open: boolean;
    onClose: () => void;
    onImported: (document: Document) => void;
    /** When set, imported contracts are added to this project. */
    projectId?: string | null;
}

function formatDate(iso: string | null) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export function IroncladImportModal({
    open,
    onClose,
    onImported,
    projectId = null,
}: Props) {
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [search, setSearch] = useState("");
    const [records, setRecords] = useState<IroncladRecordSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedRecord, setSelectedRecord] =
        useState<IroncladRecordSummary | null>(null);
    const [attachments, setAttachments] = useState<IroncladAttachment[]>([]);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [attachmentsLoading, setAttachmentsLoading] = useState(false);
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        if (!open) return;
        setSearch("");
        setRecords([]);
        setError(null);
        setSelectedRecord(null);
        setAttachments([]);
        setSelectedKey(null);
        let cancelled = false;
        getIroncladStatus()
            .then((status) => {
                if (!cancelled) setConfigured(status.configured);
            })
            .catch(() => {
                if (!cancelled) setConfigured(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open || configured !== true) return;
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            searchIroncladRecords({ search, pageSize: 25 })
                .then((result) => {
                    if (cancelled) return;
                    setRecords(result.list);
                    setError(null);
                })
                .catch((err) => {
                    if (cancelled) return;
                    setRecords([]);
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Ironclad search failed.",
                    );
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, configured, search]);

    if (!open) return null;

    async function selectRecord(record: IroncladRecordSummary) {
        setSelectedRecord(record);
        setAttachments([]);
        setSelectedKey(null);
        setAttachmentsLoading(true);
        try {
            const detail = await getIroncladRecord(record.id);
            setAttachments(detail.attachments);
            setSelectedKey(detail.attachments[0]?.key ?? null);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to load the Ironclad record.",
            );
        } finally {
            setAttachmentsLoading(false);
        }
    }

    async function handleImport() {
        if (!selectedRecord || !selectedKey || importing) return;
        setImporting(true);
        setError(null);
        try {
            const document = await importIroncladRecord({
                recordId: selectedRecord.id,
                attachmentKey: selectedKey,
                projectId,
            });
            onImported(document);
            onClose();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to import the contract.",
            );
        } finally {
            setImporting(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Import from Ironclad"]}
            size="lg"
            footerStatus={
                error ? (
                    <span className="text-xs text-red-600">{error}</span>
                ) : undefined
            }
            primaryAction={
                selectedRecord
                    ? {
                          label: importing ? "Importing..." : "Import",
                          onClick: handleImport,
                          disabled:
                              importing || !selectedKey || attachmentsLoading,
                          icon: importing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : undefined,
                      }
                    : undefined
            }
            secondaryAction={
                selectedRecord
                    ? {
                          label: "Back to results",
                          onClick: () => setSelectedRecord(null),
                          disabled: importing,
                      }
                    : undefined
            }
        >
            {configured === null ? (
                <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                </div>
            ) : configured === false ? (
                <p className="py-6 text-sm text-gray-500">
                    Ironclad is not configured on this instance. Set{" "}
                    <code className="rounded bg-gray-100 px-1">
                        IRONCLAD_API_KEY
                    </code>{" "}
                    in the backend environment and restart the backend.
                </p>
            ) : selectedRecord ? (
                <div className="flex flex-col gap-3 py-2">
                    <div>
                        <p className="text-sm font-medium text-gray-900">
                            {selectedRecord.name}
                        </p>
                        <p className="text-xs text-gray-500">
                            {[
                                selectedRecord.type,
                                selectedRecord.counterpartyName,
                                formatDate(selectedRecord.agreementDate),
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        </p>
                    </div>
                    {attachmentsLoading ? (
                        <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading attachments...
                        </div>
                    ) : attachments.length === 0 ? (
                        <p className="py-4 text-sm text-gray-500">
                            No attachments found on this record.
                        </p>
                    ) : (
                        <div className="flex flex-col gap-1.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                                Choose an attachment to import
                            </p>
                            {attachments.map((attachment) => (
                                <button
                                    key={attachment.key}
                                    type="button"
                                    onClick={() =>
                                        setSelectedKey(attachment.key)
                                    }
                                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                                        selectedKey === attachment.key
                                            ? "border-blue-500 bg-blue-50/60"
                                            : "border-gray-200 hover:bg-gray-50"
                                    }`}
                                >
                                    <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                                    <span className="min-w-0 flex-1 truncate">
                                        {attachment.filename ?? attachment.key}
                                        <span className="ml-1.5 text-xs text-gray-400">
                                            {attachment.key}
                                        </span>
                                    </span>
                                    {selectedKey === attachment.key && (
                                        <Check className="h-4 w-4 shrink-0 text-blue-600" />
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex flex-col gap-3 py-2">
                    <SearchBar
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Search Ironclad records..."
                    />
                    <div className="max-h-80 overflow-y-auto">
                        {loading ? (
                            <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Searching...
                            </div>
                        ) : records.length === 0 ? (
                            <p className="py-6 text-sm text-gray-500">
                                No records found.
                            </p>
                        ) : (
                            records.map((record) => (
                                <button
                                    key={record.id}
                                    type="button"
                                    onClick={() => selectRecord(record)}
                                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-gray-50"
                                >
                                    <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-gray-900">
                                            {record.name}
                                        </span>
                                        <span className="block truncate text-xs text-gray-500">
                                            {[
                                                record.type,
                                                record.counterpartyName,
                                                formatDate(
                                                    record.agreementDate,
                                                ),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}
