"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    AlertCircle,
    Check,
    Download,
    Loader2,
    Pencil,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { DocView } from "@/app/components/shared/DocView";
import { DocFileIcon } from "@/app/components/shared/FileDirectory";
import { WarningPopup } from "@/app/components/shared/WarningPopup";
import type { Document } from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";
import { formatBytes, formatDate } from "./ProjectPageParts";

const MIN_DOC_COLUMN_WIDTH = 420;
const DEFAULT_DOC_COLUMN_WIDTH = 620;
const MIN_DATA_COLUMN_WIDTH = 280;
const DEFAULT_DATA_COLUMN_WIDTH = 340;
const RESIZER_WIDTH = 6;
const MAX_PANEL_WIDTH = 1180;

interface DocumentSidePanelProps {
    doc: Document | null;
    versionId?: string | null;
    currentVersionId?: string | null;
    versions: DocumentVersion[];
    versionsLoading: boolean;
    onClose: () => void;
    onLoadVersions: (docId: string) => Promise<void> | void;
    onSelectVersion: (versionId: string, label: string) => void;
    onDownloadDocument: (docId: string) => Promise<void> | void;
    onDownloadVersion: (
        docId: string,
        versionId: string,
        filename: string,
    ) => Promise<void> | void;
    onRenameVersion: (
        docId: string,
        versionId: string,
        filename: string,
    ) => Promise<void> | void;
    onDeleteVersion: (
        docId: string,
        versionId: string,
    ) => Promise<void> | void;
    onUploadNewVersion: (
        doc: Document,
        file: File,
        filename: string,
    ) => Promise<void>;
    onDelete: (doc: Document) => Promise<void> | void;
}

export function DocumentSidePanel({
    doc,
    versionId,
    currentVersionId,
    versions,
    versionsLoading,
    onClose,
    onLoadVersions,
    onSelectVersion,
    onDownloadDocument,
    onDownloadVersion,
    onRenameVersion,
    onDeleteVersion,
    onUploadNewVersion,
    onDelete,
}: DocumentSidePanelProps) {
    const [mounted, setMounted] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState("");
    const [savingName, setSavingName] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [extensionWarningOpen, setExtensionWarningOpen] = useState(false);
    const [deletingVersion, setDeletingVersion] = useState(false);
    const [deletingDocument, setDeletingDocument] = useState(false);
    const [confirmDeleteDocumentOpen, setConfirmDeleteDocumentOpen] =
        useState(false);
    const [deleteDocumentStatus, setDeleteDocumentStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [dataColumnWidth, setDataColumnWidth] = useState(
        DEFAULT_DATA_COLUMN_WIDTH,
    );
    const [panelWidth, setPanelWidth] = useState(
        DEFAULT_DOC_COLUMN_WIDTH + RESIZER_WIDTH + DEFAULT_DATA_COLUMN_WIDTH,
    );
    const panelRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragStartX = useRef(0);
    const dragStartDataWidth = useRef(DEFAULT_DATA_COLUMN_WIDTH);
    const dragStartPanelWidth = useRef(
        DEFAULT_DOC_COLUMN_WIDTH + RESIZER_WIDTH + DEFAULT_DATA_COLUMN_WIDTH,
    );

    useEffect(() => setMounted(true), []);

    useEffect(() => {
        if (!mounted) return;
        function handleWindowResize() {
            setPanelWidth((width) => clampPanelWidth(width, dataColumnWidth));
        }
        handleWindowResize();
        window.addEventListener("resize", handleWindowResize);
        return () => window.removeEventListener("resize", handleWindowResize);
    }, [dataColumnWidth, mounted]);

    useEffect(() => {
        if (!doc) return;
        setUploadError(null);
        void onLoadVersions(doc.id);
    }, [doc?.id]);

    useEffect(() => {
        setEditingName(false);
        setNameDraft("");
        setNameError(null);
        setExtensionWarningOpen(false);
    }, [doc?.id, versionId, currentVersionId]);

    if (!mounted || !doc) return null;

    const activeDoc = doc;
    const documentId = activeDoc.id;
    const accept = doc.file_type === "pdf" ? ".pdf" : ".docx,.doc";
    const orderedVersions = [...versions].reverse();
    const selectedVersion =
        versions.find((version) => version.id === versionId) ??
        versions.find((version) => version.id === currentVersionId) ??
        orderedVersions[0] ??
        null;
    const selectedVersionId = selectedVersion?.id ?? versionId ?? null;
    const selectedFilename =
        selectedVersion?.filename?.trim() || doc.filename;
    const selectedFileType =
        selectedVersion != null
            ? fileTypeForVersion(selectedVersion, doc.file_type)
            : doc.file_type;
    const selectedSizeBytes =
        selectedVersion?.size_bytes === undefined
            ? doc.size_bytes
            : selectedVersion.size_bytes;
    const selectedPageCount =
        selectedVersion?.page_count === undefined
            ? doc.page_count
            : selectedVersion.page_count;
    const selectedVersionNumber =
        selectedVersion?.version_number ?? doc.active_version_number ?? null;
    const selectedUploadedAt = selectedVersion?.created_at ?? doc.created_at;
    const selectedExtension = filenameExtension(selectedFilename);

    async function handleSaveName() {
        if (!selectedVersionId) return;
        const trimmed = nameDraft.trim();
        if (!trimmed) {
            setNameError("Name is required.");
            return;
        }
        if (hasExtensionChange(selectedFilename, trimmed)) {
            setExtensionWarningOpen(true);
            return;
        }
        if (trimmed === selectedFilename) {
            setEditingName(false);
            setNameError(null);
            return;
        }

        setSavingName(true);
        setNameError(null);
        try {
            await onRenameVersion(documentId, selectedVersionId, trimmed);
            setEditingName(false);
        } catch (err) {
            console.error("rename version failed", err);
            setNameError("Could not save name.");
        } finally {
            setSavingName(false);
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0] ?? null;
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!file || !doc) return;
        setUploadError(null);
        setUploading(true);
        try {
            await onUploadNewVersion(doc, file, file.name);
        } catch (err) {
            console.error("upload new version failed", err);
            setUploadError("Could not upload the new version.");
        } finally {
            setUploading(false);
        }
    }

    async function handleDeleteSelectedVersion() {
        if (!selectedVersionId) return;
        setDeletingVersion(true);
        try {
            await onDeleteVersion(documentId, selectedVersionId);
        } catch (err) {
            console.error("delete version failed", err);
        } finally {
            setDeletingVersion(false);
        }
    }

    async function handleDeleteDocument() {
        if (deleteDocumentStatus === "deleting") return;
        setDeleteDocumentStatus("deleting");
        setDeletingDocument(true);
        try {
            await onDelete(activeDoc);
            setDeleteDocumentStatus("deleted");
            window.setTimeout(() => {
                setConfirmDeleteDocumentOpen(false);
                setDeleteDocumentStatus("idle");
                onClose();
            }, 650);
        } catch (err) {
            console.error("delete document failed", err);
            setDeleteDocumentStatus("idle");
        } finally {
            setDeletingDocument(false);
        }
    }

    function requestDeleteDocument() {
        if (versions.length > 1) {
            setDeleteDocumentStatus("idle");
            setConfirmDeleteDocumentOpen(true);
            return;
        }
        void handleDeleteDocument();
    }

    function handleResizeMouseDown(e: React.MouseEvent<HTMLDivElement>) {
        e.preventDefault();
        dragStartX.current = e.clientX;
        dragStartDataWidth.current = dataColumnWidth;

        const handleMouseMove = (event: MouseEvent) => {
            const panelWidth =
                panelRef.current?.clientWidth ?? window.innerWidth;
            const maxDataWidth = Math.max(
                MIN_DATA_COLUMN_WIDTH,
                panelWidth - MIN_DOC_COLUMN_WIDTH - RESIZER_WIDTH,
            );
            const nextWidth =
                dragStartDataWidth.current + (dragStartX.current - event.clientX);
            setDataColumnWidth(
                Math.min(
                    maxDataWidth,
                    Math.max(MIN_DATA_COLUMN_WIDTH, nextWidth),
                ),
            );
        };

        const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    function handlePanelResizeMouseDown(e: React.MouseEvent<HTMLDivElement>) {
        e.preventDefault();
        dragStartX.current = e.clientX;
        dragStartPanelWidth.current = panelWidth;

        const handleMouseMove = (event: MouseEvent) => {
            const nextWidth =
                dragStartPanelWidth.current + (dragStartX.current - event.clientX);
            setPanelWidth(clampPanelWidth(nextWidth, dataColumnWidth));
        };

        const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    return createPortal(
        <div
            ref={panelRef}
            className={cn(
                "fixed z-[190] flex flex-col",
                "inset-y-3 right-3 rounded-2xl border border-white/70 bg-white/72 shadow-[0_8px_24px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_24px_rgba(255,255,255,0.18),inset_1px_0_0_rgba(255,255,255,0.5)] backdrop-blur-2xl overflow-hidden",
            )}
            style={{ width: panelWidth }}
        >
            <div
                onMouseDown={handlePanelResizeMouseDown}
                className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-blue-400/60"
                title="Resize document view"
            />
            <div
                className={cn(
                    "flex h-11 shrink-0 items-center justify-between px-4",
                    "border-b border-white/60 bg-white/35",
                )}
            >
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-700">
                        {selectedFilename}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-7 w-7 items-center justify-center text-gray-500 transition-colors hover:text-gray-900"
                        title="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <div
                className="grid min-h-0 flex-1"
                style={{
                    gridTemplateColumns: `minmax(${MIN_DOC_COLUMN_WIDTH}px, 1fr) ${RESIZER_WIDTH}px ${dataColumnWidth}px`,
                }}
            >
                <section
                    className={cn(
                        "flex min-h-0 min-w-0 pb-3 pl-3",
                        "bg-white/20",
                    )}
                >
                    <div
                        className={cn(
                            "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                            "rounded-xl border border-white/60 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl",
                        )}
                    >
                        <DocView
                            key={selectedVersionId ?? "current"}
                            doc={{
                                document_id: doc.id,
                                version_id: selectedVersionId,
                            }}
                        />
                    </div>
                </section>

                <div
                    onMouseDown={handleResizeMouseDown}
                    className={cn(
                        "relative cursor-col-resize transition-colors",
                        "bg-white/25 hover:bg-blue-400/60",
                    )}
                    title="Resize document panel"
                />

                <aside
                    className={cn(
                        "flex min-h-0 flex-col",
                        "bg-white/25",
                    )}
                >
                    <div
                        className={cn(
                            "shrink-0 px-4 pb-3 pt-0",
                            "border-b border-white/60",
                        )}
                    >
                        <div className="mb-4">
                            <div className="mb-3 text-xs font-medium text-gray-900">
                                Name
                            </div>
                            {editingName ? (
                                <div className="space-y-1.5">
                                    <div className="flex min-h-6 items-center gap-2">
                                    <input
                                        value={nameDraft}
                                        onChange={(e) => {
                                            setNameDraft(e.target.value);
                                            setNameError(null);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                void handleSaveName();
                                            }
                                            if (e.key === "Escape") {
                                                setEditingName(false);
                                                setNameError(null);
                                            }
                                        }}
                                        className="h-6 min-w-0 flex-1 border-0 border-b border-gray-300 bg-transparent px-0 text-xs leading-6 text-gray-900 outline-none transition-colors focus:border-gray-500"
                                        autoFocus
                                    />
                                        <button
                                            type="button"
                                            onClick={() => void handleSaveName()}
                                            disabled={savingName}
                                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/65 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
                                            title="Save name"
                                        >
                                            {savingName ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Check className="h-3.5 w-3.5" />
                                            )}
                                        </button>
                                    </div>
                                    {nameError && (
                                        <div className="text-xs text-red-600">
                                            {nameError}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex min-h-6 items-center gap-2">
                                    <div className="min-w-0 flex-1 truncate text-xs leading-6 text-gray-800">
                                        {selectedFilename}
                                    </div>
                                    {selectedVersionId && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setNameDraft(selectedFilename);
                                                setEditingName(true);
                                                setNameError(null);
                                            }}
                                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/65 hover:text-gray-900"
                                            title="Edit name"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="mb-3 text-xs font-medium text-gray-900">
                            Document Data
                        </div>
                        <div className="space-y-1.5">
                            <DataRow label="Type" value={selectedFileType ?? "—"} />
                            <DataRow
                                label="Size"
                                value={
                                    selectedSizeBytes != null
                                        ? formatBytes(selectedSizeBytes)
                                        : "—"
                                }
                            />
                            <DataRow
                                label="Version"
                                value={
                                    selectedVersionNumber != null
                                        ? String(selectedVersionNumber)
                                        : "—"
                                }
                            />
                            <DataRow
                                label="Uploaded"
                                value={
                                    selectedUploadedAt
                                        ? formatDate(selectedUploadedAt)
                                        : "—"
                                }
                            />
                            {selectedPageCount != null && (
                                <DataRow
                                    label="Pages"
                                    value={String(selectedPageCount)}
                                />
                            )}
                        </div>
                        <div className="mt-4 flex items-center justify-between gap-2">
                            <button
                                type="button"
                                onClick={() =>
                                    void handleDeleteSelectedVersion()
                                }
                                disabled={
                                    !selectedVersionId ||
                                    versions.length <= 1 ||
                                    deletingVersion
                                }
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg border border-gray-300/80 bg-white/65 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:border-red-200 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40",
                                )}
                            >
                                {deletingVersion ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Trash2 className="h-3.5 w-3.5" />
                                )}
                                Delete version
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    selectedVersionId
                                        ? void onDownloadVersion(
                                              doc.id,
                                              selectedVersionId,
                                              selectedFilename,
                                          )
                                        : void onDownloadDocument(doc.id)
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300/80 bg-white/65 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-white hover:text-gray-900"
                            >
                                <Download className="h-3.5 w-3.5" />
                                Download
                            </button>
                        </div>
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-0">
                        <div
                            className={cn(
                                "flex min-h-0 flex-1 flex-col overflow-visible rounded-xl",
                                "border border-white/60 bg-white/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]",
                            )}
                        >
                            <div
                                className={cn(
                                    "shrink-0 py-2 text-xs font-medium text-gray-900",
                                    "border-b border-white/60",
                                )}
                            >
                                Versions
                            </div>
                            <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 py-2">
                                {versionsLoading && versions.length === 0 ? (
                                    <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Loading versions
                                    </div>
                                ) : orderedVersions.length === 0 ? (
                                    <div className="py-2 text-xs text-gray-400">
                                        No version history.
                                    </div>
                                ) : (
                                    <div className="space-y-1">
                                        {orderedVersions.map((version) => {
                                            const title =
                                                versionTitleFor(version);
                                            const filename =
                                                versionFilenameFor(version);
                                            const selected =
                                                selectedVersionId === version.id;
                                            const fileType =
                                                fileTypeForVersion(
                                                    version,
                                                    doc.file_type,
                                                );
                                            return (
                                                <button
                                                    key={version.id}
                                                    type="button"
                                                    onClick={() =>
                                                        onSelectVersion(
                                                            version.id,
                                                            filename,
                                                        )
                                                    }
                                                    className={cn(
                                                        "group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                                                        selected
                                                            ? "bg-gray-100"
                                                            : "hover:bg-white/55",
                                                    )}
                                                >
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex min-w-0 items-center gap-2">
                                                            <DocFileIcon
                                                                fileType={
                                                                    fileType
                                                                }
                                                            />
                                                            <div className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800">
                                                                {title}
                                                            </div>
                                                        </div>
                                                        <div className="truncate pl-[22px] text-[11px] text-gray-400">
                                                            {filename}
                                                        </div>
                                                        <div className="truncate pl-[22px] text-[11px] text-gray-400">
                                                            {version.created_at
                                                                ? new Date(
                                                                      version.created_at,
                                                                  ).toLocaleString()
                                                                : "—"}
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {uploadError && (
                        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-gray-900">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                            <span>{uploadError}</span>
                        </div>
                    )}

                    <div
                        className={cn(
                            "flex shrink-0 items-center justify-between px-4 py-3",
                            "border-t border-white/60 bg-white/25",
                        )}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={accept}
                            className="hidden"
                            onChange={handleUpload}
                        />
                        <button
                            type="button"
                            onClick={requestDeleteDocument}
                            disabled={deletingDocument}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-300/80 bg-white/35 px-3 text-xs font-medium text-red-600 transition-colors hover:border-red-200 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {deletingDocument ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                            )}
                            Delete
                        </button>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-300/80 bg-white/35 px-3 text-xs font-medium text-gray-800 transition-colors hover:border-gray-400 hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {uploading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Upload className="h-3.5 w-3.5" />
                            )}
                            Upload new version
                        </button>
                    </div>
                </aside>
            </div>
            <WarningPopup
                open={extensionWarningOpen}
                onClose={() => setExtensionWarningOpen(false)}
                message={
                    selectedExtension
                        ? `File extensions cannot be changed here. Keep ${selectedExtension} at the end of the name.`
                        : "File extensions cannot be changed here."
                }
            />
            <ConfirmPopup
                open={confirmDeleteDocumentOpen}
                title="Delete document?"
                message={`${selectedFilename} has ${versions.length} versions. Deleting this document will delete all of its versions.`}
                confirmLabel="Delete"
                confirmStatus={
                    deleteDocumentStatus === "deleting"
                        ? "loading"
                        : deleteDocumentStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (deleteDocumentStatus === "deleting") return;
                    setConfirmDeleteDocumentOpen(false);
                    setDeleteDocumentStatus("idle");
                }}
                onConfirm={() => void handleDeleteDocument()}
            />
        </div>,
        document.body,
    );
}

function DataRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 text-xs">
            <span className="text-gray-400">{label}</span>
            <span className="truncate text-gray-800">{value}</span>
        </div>
    );
}

function clampPanelWidth(width: number, dataColumnWidth: number) {
    const minWidth = MIN_DOC_COLUMN_WIDTH + RESIZER_WIDTH + dataColumnWidth;
    const maxWidth =
        typeof window === "undefined"
            ? MAX_PANEL_WIDTH
            : Math.min(MAX_PANEL_WIDTH, window.innerWidth - 16);
    return Math.min(maxWidth, Math.max(minWidth, width));
}

function versionTitleFor(version: DocumentVersion) {
    if (
        typeof version.version_number === "number" &&
        version.version_number >= 1
    ) {
        return `Version ${version.version_number}`;
    }
    return "Version";
}

function versionFilenameFor(version: DocumentVersion) {
    if (version.filename?.trim()) return version.filename.trim();
    return version.source === "upload" ? "Original" : "—";
}

function fileTypeForVersion(
    version: DocumentVersion,
    fallback: string | null,
) {
    const name = version.filename?.trim().toLowerCase() ?? "";
    if (name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".doc") || name.endsWith(".docx")) return "docx";
    return fallback;
}

function filenameExtension(filename: string) {
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null;
    return trimmed.slice(dotIndex);
}

function hasExtensionChange(previous: string, next: string) {
    const previousExtension = filenameExtension(previous);
    if (previousExtension == null) return false;
    return (
        filenameExtension(next)?.toLowerCase() !==
        previousExtension.toLowerCase()
    );
}
