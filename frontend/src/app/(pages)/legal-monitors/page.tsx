"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertCircle,
    Bell,
    Check,
    CirclePause,
    Clock3,
    ExternalLink,
    FileText,
    FileSearch,
    Globe2,
    LibraryBig,
    Loader2,
    Mail,
    Pencil,
    Play,
    Plus,
    Radar,
    Rss,
    Scale,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileDirectory } from "@/app/components/shared/FileDirectory";
import { PageHeader } from "@/app/components/shared/PageHeader";
import type { Document } from "@/app/components/shared/types";
import { Modal } from "@/app/components/modals/Modal";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { PillButton } from "@/app/components/ui/pill-button";
import {
    SETTINGS_MODELS,
    useConfiguredModelOptions,
} from "@/app/components/assistant/ModelToggle";
import { cn } from "@/app/lib/utils";
import {
    createLegalMonitor,
    deleteLegalMonitor,
    getLegalMonitorConfiguration,
    getLibrary,
    listLegalMonitorRuns,
    listLegalMonitors,
    parseLegalMonitorOpml,
    runLegalMonitorNow,
    updateLegalMonitor,
    type LegalMonitor,
    type LegalMonitorConfiguration,
    type LegalMonitorConnectorConfig,
    type LegalMonitorInput,
    type LegalMonitorPreset,
    type LegalMonitorRun,
    type LegalMonitorSourceInput,
    type LegalMonitorSourceType,
    LEGAL_MONITOR_SEVERITIES,
    type LegalMonitorSeverity,
} from "@/app/lib/mikeApi";

// No hardcoded provider default: the monitor form requires an explicit
    // pick before saving (see canSave).
const DEFAULT_MODEL = "";

const EMPTY_DRAFT: LegalMonitorInput = {
    name: "",
    topic: "",
    jurisdiction: "United States federal",
    sourceTypes: [],
    connectorId: null,
    connectorConfig: { mode: "agent" },
    sources: [],
    documentIds: [],
    model: DEFAULT_MODEL,
    intervalHours: 24,
    lookbackDays: 14,
    maxItemsPerRun: 50,
    alertEmail: null,
    emailEnabled: false,
    knowledgeCaptureEnabled: false,
    materialityThreshold: "low",
    enabled: true,
};

function dateTime(value: string | null) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
        hour: "numeric",
        minute: "2-digit",
    });
}

function intervalLabel(hours: number) {
    if (hours < 24) return `Every ${hours} hours`;
    if (hours === 24) return "Daily";
    if (hours === 168) return "Weekly";
    if (hours === 336) return "Every 2 weeks";
    if (hours === 720) return "Monthly";
    return `Every ${hours / 24} days`;
}

const SEVERITY_LABEL: Record<LegalMonitorSeverity, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
};

// Colour reinforces the ranking; the word carries it, so the meaning survives
// for anyone who cannot separate these hues.
const SEVERITY_TEXT_CLASS: Record<LegalMonitorSeverity, string> = {
    critical: "text-red-700",
    high: "text-amber-700",
    medium: "text-gray-600",
    low: "text-gray-400",
};

function severityLabel(severity: LegalMonitorSeverity) {
    return SEVERITY_LABEL[severity] ?? SEVERITY_LABEL.medium;
}

function sourceTypeLabel(source: LegalMonitorSourceType) {
    return source === "case_law" ? "Case law" : "Statutes";
}

function connectorConfigLabel(config: LegalMonitorConnectorConfig, sourceTypes: LegalMonitorSourceType[]) {
    if (config.mode === "trademark_prefix") {
        return `Begins with "${config.prefix}" · ${config.status === "all" ? "All statuses" : config.status === "live" ? "Live" : "Dead"} · ${config.internationalClass ? `Class ${config.internationalClass}` : "All classes"}`;
    }
    return sourceTypes.length ? sourceTypes.map(sourceTypeLabel).join(" · ") : "Agent-directed research";
}

function draftFromMonitor(monitor: LegalMonitor): LegalMonitorInput {
    return {
        name: monitor.name,
        topic: monitor.topic,
        jurisdiction: monitor.jurisdiction,
        sourceTypes: monitor.sourceTypes,
        connectorId: monitor.connectorId,
        connectorConfig: monitor.connectorConfig,
        sources: monitor.sources.map(({ id, kind, name, url, category, enabled }) => ({ id, kind, name, url, category, enabled })),
        documentIds: monitor.referenceDocuments.map((document) => document.id),
        model: monitor.model,
        intervalHours: monitor.intervalHours,
        lookbackDays: monitor.lookbackDays,
        maxItemsPerRun: monitor.maxItemsPerRun,
        alertEmail: monitor.alertEmail,
        emailEnabled: monitor.emailEnabled,
        knowledgeCaptureEnabled: monitor.knowledgeCaptureEnabled,
        materialityThreshold: monitor.materialityThreshold,
        enabled: monitor.enabled,
    };
}

export default function LegalMonitorsPage() {
    const configuredModelOptions = useConfiguredModelOptions(SETTINGS_MODELS);
    const [monitors, setMonitors] = useState<LegalMonitor[]>([]);
    const [configuration, setConfiguration] = useState<LegalMonitorConfiguration | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [runs, setRuns] = useState<LegalMonitorRun[]>([]);
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [runsLoading, setRunsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<LegalMonitorInput>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [runningId, setRunningId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [importing, setImporting] = useState(false);
    const [referenceDocuments, setReferenceDocuments] = useState<Document[]>([]);
    const [libraryDocuments, setLibraryDocuments] = useState<Document[]>([]);
    const [librarySelection, setLibrarySelection] = useState<Document[]>([]);
    const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
    const [libraryLoading, setLibraryLoading] = useState(false);

    const selected = monitors.find((monitor) => monitor.id === selectedId) ?? null;
    const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
    const selectedConnector = configuration?.connectors.find((connector) => connector.id === draft.connectorId) ?? null;
    const supportsTrademarkPrefix = selectedConnector?.tools.some(
        (tool) => tool.toolName === "tm_search_trademarks" && tool.enabled && !tool.requiresConfirmation,
    ) ?? false;
    const selectedConnectorText = selectedConnector ? [
        selectedConnector.name,
        selectedConnector.serverUrl,
        ...selectedConnector.tools.flatMap((tool) => [tool.toolName, tool.title ?? "", tool.description ?? ""]),
    ].join(" ").toLowerCase() : "";
    const selectedConnectorIsDingDuff = selectedConnectorText.includes("dingduff")
        || selectedConnectorText.includes("ding-duff")
        || selectedConnectorText.includes("ding duff");

    const loadPage = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [loadedMonitors, loadedConfiguration] = await Promise.all([
                listLegalMonitors(),
                getLegalMonitorConfiguration(),
            ]);
            setMonitors(loadedMonitors);
            setConfiguration(loadedConfiguration);
            setSelectedId((current) => current && loadedMonitors.some((monitor) => monitor.id === current) ? current : loadedMonitors[0]?.id ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not load legal monitors.");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadRuns = useCallback(async (monitorId: string) => {
        setRunsLoading(true);
        try {
            const loaded = await listLegalMonitorRuns(monitorId);
            setRuns(loaded);
            setSelectedRunId(loaded[0]?.id ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not load monitor history.");
            setRuns([]);
        } finally {
            setRunsLoading(false);
        }
    }, []);

    useEffect(() => { void loadPage(); }, [loadPage]);
    useEffect(() => {
        if (selectedId) void loadRuns(selectedId);
        else { setRuns([]); setSelectedRunId(null); }
    }, [loadRuns, selectedId]);

    const modelOptions = useMemo(() => {
        return configuredModelOptions.map((model) => ({
            value: model.id,
            label: `${model.group} · ${model.label}`,
        }));
    }, [configuredModelOptions]);

    function baseDraft(): LegalMonitorInput {
        return {
            ...EMPTY_DRAFT,
            connectorId: null,
            alertEmail: configuration?.defaultEmail || null,
        };
    }

    function openCreate() {
        setEditingId(null);
        setDraft(baseDraft());
        setReferenceDocuments([]);
        setError(null);
        setEditorOpen(true);
    }

    function openPreset(preset: LegalMonitorPreset) {
        setEditingId(null);
        const requiredConnector = preset.requiredToolName
            ? configuration?.connectors.find((connector) => connector.tools.some(
                  (tool) => tool.toolName === preset.requiredToolName && tool.enabled && !tool.requiresConfirmation,
              ))
            : null;
        setDraft({
            ...baseDraft(),
            ...preset.monitor,
            connectorId: requiredConnector?.id ?? null,
            connectorConfig: preset.monitor.connectorConfig ?? { mode: "agent" },
            sources: preset.sources.map((source) => ({ ...source })),
            documentIds: [],
        });
        setReferenceDocuments([]);
        setError(null);
        setEditorOpen(true);
    }

    function openEdit() {
        if (!selected) return;
        setEditingId(selected.id);
        setDraft(draftFromMonitor(selected));
        setReferenceDocuments(selected.referenceDocuments.map(referenceDocumentToDocument));
        setError(null);
        setEditorOpen(true);
    }

    async function saveMonitor() {
        setSaving(true);
        setError(null);
        try {
            const saved = editingId ? await updateLegalMonitor(editingId, draft) : await createLegalMonitor(draft);
            setMonitors((current) => current.some((monitor) => monitor.id === saved.id)
                ? current.map((monitor) => monitor.id === saved.id ? saved : monitor)
                : [saved, ...current]);
            setSelectedId(saved.id);
            setEditorOpen(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save monitor.");
        } finally {
            setSaving(false);
        }
    }

    async function runNow() {
        if (!selected) return;
        setRunningId(selected.id);
        setError(null);
        try {
            const completed = await runLegalMonitorNow(selected.id);
            setRuns((current) => [completed, ...current.filter((run) => run.id !== completed.id)]);
            setSelectedRunId(completed.id);
            await loadPage();
            setSelectedId(selected.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Monitor run failed.");
            await Promise.all([loadPage(), loadRuns(selected.id)]);
            setSelectedId(selected.id);
        } finally {
            setRunningId(null);
        }
    }

    async function toggleEnabled() {
        if (!selected) return;
        setError(null);
        try {
            const saved = await updateLegalMonitor(selected.id, { ...draftFromMonitor(selected), enabled: !selected.enabled });
            setMonitors((current) => current.map((monitor) => monitor.id === saved.id ? saved : monitor));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not update monitor.");
        }
    }

    async function removeMonitor() {
        if (!selected) return;
        setDeleting(true);
        setError(null);
        try {
            await deleteLegalMonitor(selected.id);
            const remaining = monitors.filter((monitor) => monitor.id !== selected.id);
            setMonitors(remaining);
            setSelectedId(remaining[0]?.id ?? null);
            setConfirmDelete(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not delete monitor.");
        } finally {
            setDeleting(false);
        }
    }

    async function importOpml(file: File | undefined) {
        if (!file) return;
        setImporting(true);
        setError(null);
        try {
            const imported = await parseLegalMonitorOpml(await file.text());
            setDraft((current) => {
                const existing = new Set(current.sources.map((source) => `${source.kind}:${source.url}`));
                return { ...current, sources: [...current.sources, ...imported.filter((source) => !existing.has(`${source.kind}:${source.url}`))] };
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not import OPML.");
        } finally {
            setImporting(false);
        }
    }

    function updateSource(index: number, patch: Partial<LegalMonitorSourceInput>) {
        setDraft((current) => ({ ...current, sources: current.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : source) }));
    }

    function removeSource(index: number) {
        setDraft((current) => ({ ...current, sources: current.sources.filter((_, sourceIndex) => sourceIndex !== index) }));
    }

    async function openLibraryPicker() {
        setLibraryPickerOpen(true);
        setLibraryLoading(true);
        try {
            const library = await getLibrary("files");
            const readyDocuments = library.documents.filter(
                (document) => document.status === "ready" && !!document.storage_path,
            );
            const byId = new Map(readyDocuments.map((document) => [document.id, document]));
            setLibraryDocuments(readyDocuments);
            setLibrarySelection(
                draft.documentIds.flatMap((id) => {
                    const document = byId.get(id)
                        ?? referenceDocuments.find((candidate) => candidate.id === id);
                    return document ? [document] : [];
                }),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not load Library files.");
            setLibraryPickerOpen(false);
        } finally {
            setLibraryLoading(false);
        }
    }

    function confirmLibrarySelection() {
        if (librarySelection.length > 10) return;
        setReferenceDocuments(librarySelection);
        setDraft((current) => ({
            ...current,
            documentIds: librarySelection.map((document) => document.id),
        }));
        setLibraryPickerOpen(false);
    }

    function removeReferenceDocument(documentId: string) {
        setReferenceDocuments((current) =>
            current.filter((document) => document.id !== documentId),
        );
        setDraft((current) => ({
            ...current,
            documentIds: current.documentIds.filter((id) => id !== documentId),
        }));
    }

    const connectorConfigValid = draft.connectorConfig.mode !== "trademark_prefix" || !!draft.connectorConfig.prefix.trim();
    const canSave = !!draft.name.trim() && !!draft.topic.trim() && !!draft.model && connectorConfigValid && (!!draft.connectorId || draft.sources.some((source) => source.enabled));

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader breadcrumbs={[{ label: "Legal monitors" }]} actions={[{ type: "new", onClick: openCreate, disabled: loading }]} />

            {error && (
                <div role="alert" className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:mx-6">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">{error}</span>
                    <button type="button" onClick={() => setError(null)} className="text-xs font-medium">Dismiss</button>
                </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-1">
                <aside className="max-h-60 min-h-0 overflow-y-auto border-b border-gray-200 px-4 pb-4 md:max-h-none md:border-b-0 md:border-r md:px-5">
                    <div className="sticky top-0 z-10 flex items-center justify-between bg-white py-3">
                        <span className="text-xs font-semibold uppercase text-gray-400">Monitors</span>
                        <span className="text-xs text-gray-400">{monitors.length}</span>
                    </div>
                    {loading ? <LoadingState /> : monitors.length ? (
                        <div className="space-y-1">
                            {monitors.map((monitor) => (
                                <button key={monitor.id} type="button" onClick={() => setSelectedId(monitor.id)} className={cn("w-full rounded-md px-3 py-3 text-left transition-colors", selectedId === monitor.id ? "bg-gray-100" : "hover:bg-gray-50")}>
                                    <div className="flex items-start gap-2">
                                        <Radar className={cn("mt-0.5 h-4 w-4 shrink-0", monitor.enabled ? "text-blue-600" : "text-gray-300")} />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-gray-800">{monitor.name}</p>
                                            <p className="mt-1 truncate text-xs text-gray-400">{monitor.sources.length + (monitor.connectorName ? 1 : 0)} source{monitor.sources.length + (monitor.connectorName ? 1 : 0) === 1 ? "" : "s"}{monitor.connectorName ? ` · ${monitor.connectorName}` : ""}</p>
                                        </div>
                                        <StatusDot status={monitor.lastStatus} enabled={monitor.enabled} />
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="space-y-3 py-6">
                            <Radar className="h-6 w-6 text-gray-300" />
                            <p className="text-sm text-gray-500">No monitors configured.</p>
                            {(configuration?.presets ?? []).map((preset) => (
                                <button key={preset.id} type="button" onClick={() => openPreset(preset)} className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50">
                                    <Plus className="h-4 w-4 text-blue-600" />
                                    <span className="truncate">{preset.name}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </aside>

                <main className="min-h-0 overflow-y-auto">
                    {selected ? (
                        <MonitorDetail
                            monitor={selected}
                            runs={runs}
                            selectedRun={selectedRun}
                            selectedRunId={selectedRunId}
                            runsLoading={runsLoading}
                            running={runningId === selected.id}
                            onSelectRun={setSelectedRunId}
                            onRun={() => void runNow()}
                            onEdit={openEdit}
                            onToggle={() => void toggleEnabled()}
                            onDelete={() => setConfirmDelete(true)}
                        />
                    ) : !loading ? (
                        <div className="flex h-full min-h-72 items-center justify-center px-6 text-center">
                            <div>
                                <Scale className="mx-auto h-8 w-8 text-gray-300" />
                                <p className="mt-3 text-sm text-gray-500">Create a monitor or start from a preset.</p>
                                <div className="mt-4 flex flex-wrap justify-center gap-2">
                                    {(configuration?.presets ?? []).map((preset) => <PillButton key={preset.id} tone="blue" size="normal" onClick={() => openPreset(preset)}><Plus className="h-4 w-4" />{preset.name}</PillButton>)}
                                    <PillButton tone="black" size="normal" onClick={openCreate}><Plus className="h-4 w-4" />New monitor</PillButton>
                                </div>
                            </div>
                        </div>
                    ) : null}
                </main>
            </div>

            <Modal
                open={editorOpen}
                onClose={() => !saving && setEditorOpen(false)}
                size="xl"
                breadcrumbs={[editingId ? "Edit monitor" : "New monitor"]}
                primaryAction={{ label: saving ? "Saving" : "Save monitor", icon: saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />, onClick: () => void saveMonitor(), disabled: saving || !canSave }}
                cancelAction={{ label: "Cancel", onClick: () => setEditorOpen(false), disabled: saving }}
            >
                <div className="min-h-0 flex-1 overflow-y-auto pb-5 pr-1">
                    <div className="space-y-5">
                        <div>
                            <ModalFieldLabel htmlFor="monitor-name">Name</ModalFieldLabel>
                            <ModalTextInput id="monitor-name" value={draft.name} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Fintech GC Regulatory Digest" />
                        </div>
                        <div>
                            <ModalFieldLabel htmlFor="monitor-topic">Analysis instructions</ModalFieldLabel>
                            <textarea id="monitor-topic" value={draft.topic} maxLength={5000} onChange={(event) => setDraft((current) => ({ ...current, topic: event.target.value }))} rows={7} className="w-full resize-y rounded-xl border border-white/70 bg-white px-3 py-2.5 text-sm leading-6 text-gray-700 shadow-sm outline-none placeholder:text-gray-400" />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="sm:col-span-2"><ModalFieldLabel htmlFor="monitor-jurisdiction">Jurisdiction</ModalFieldLabel><ModalTextInput id="monitor-jurisdiction" value={draft.jurisdiction} maxLength={200} onChange={(event) => setDraft((current) => ({ ...current, jurisdiction: event.target.value }))} /></div>
                            <div><ModalFieldLabel htmlFor="monitor-frequency">Frequency</ModalFieldLabel><ModalSelect id="monitor-frequency" value={String(draft.intervalHours)} options={(configuration?.intervals ?? [24, 168]).map((hours) => ({ value: String(hours), label: intervalLabel(hours) }))} onChange={(value) => setDraft((current) => ({ ...current, intervalHours: Number(value) }))} /></div>
                            <div><ModalFieldLabel htmlFor="monitor-lookback">Initial lookback</ModalFieldLabel><ModalSelect id="monitor-lookback" value={String(draft.lookbackDays)} options={[1, 7, 14, 30, 90, 365].map((days) => ({ value: String(days), label: `${days} day${days === 1 ? "" : "s"}` }))} onChange={(value) => setDraft((current) => ({ ...current, lookbackDays: Number(value) }))} /></div>
                        </div>

                        <section className="border-t border-gray-200 pt-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <h3 className="text-sm font-semibold text-gray-800">Library context</h3>
                                    <p className="text-xs text-gray-400">Optional background used to assess new developments</p>
                                </div>
                                <PillButton tone="white" onClick={() => void openLibraryPicker()}>
                                    <Plus className="h-3.5 w-3.5" />
                                    Add files
                                </PillButton>
                            </div>
                            {referenceDocuments.length > 0 && (
                                <div className="mt-3 divide-y divide-gray-100 border-y border-gray-200">
                                    {referenceDocuments.map((document) => (
                                        <div key={document.id} className="flex min-w-0 items-center gap-3 py-2.5">
                                            <FileText className="h-4 w-4 shrink-0 text-blue-600" />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium text-gray-700">{document.filename}</p>
                                                <p className="text-xs text-gray-400">{document.file_type?.toUpperCase() || "File"}{document.active_version_number ? ` · V${document.active_version_number}` : ""}</p>
                                            </div>
                                            <button type="button" aria-label={`Remove ${document.filename}`} title="Remove file" onClick={() => removeReferenceDocument(document.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600">
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section className="border-t border-gray-200 pt-4">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div><h3 className="text-sm font-semibold text-gray-800">RSS and web sources</h3><p className="text-xs text-gray-400">{draft.sources.length} configured</p></div>
                                <div className="flex gap-2">
                                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                                        {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}Import OPML
                                        <input type="file" accept=".opml,.xml,text/xml" className="hidden" disabled={importing} onChange={(event) => { void importOpml(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                                    </label>
                                    <PillButton tone="white" onClick={() => setDraft((current) => ({ ...current, sources: [...current.sources, { kind: "rss", name: "", url: "https://", category: null, enabled: true }] }))}><Plus className="h-3.5 w-3.5" />Source</PillButton>
                                </div>
                            </div>
                            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                {draft.sources.map((source, index) => (
                                    <div key={source.id ?? `${source.kind}-${index}`} className="grid gap-2 rounded-md border border-gray-200 bg-white p-2 sm:grid-cols-[110px_minmax(140px,0.8fr)_minmax(220px,1.4fr)_76px]">
                                        <ModalSelect id={`source-kind-${index}`} value={source.kind} options={[{ value: "rss", label: "RSS / Atom" }, { value: "web", label: "Web page" }]} onChange={(value) => updateSource(index, { kind: value as "rss" | "web" })} />
                                        <ModalTextInput id={`source-name-${index}`} value={source.name} maxLength={160} placeholder="Source name" onChange={(event) => updateSource(index, { name: event.target.value })} />
                                        <ModalTextInput id={`source-url-${index}`} value={source.url} placeholder="https://..." onChange={(event) => updateSource(index, { url: event.target.value })} />
                                        <div className="flex">
                                            <button type="button" aria-label={source.enabled ? `Disable ${source.name || "source"}` : `Enable ${source.name || "source"}`} title={source.enabled ? "Disable source" : "Enable source"} onClick={() => updateSource(index, { enabled: !source.enabled })} className={cn("flex h-10 w-9 items-center justify-center rounded-md", source.enabled ? "text-emerald-600 hover:bg-emerald-50" : "text-gray-300 hover:bg-gray-50")}>{source.enabled ? <Check className="h-4 w-4" /> : <CirclePause className="h-4 w-4" />}</button>
                                            <button type="button" aria-label={`Remove ${source.name || "source"}`} title="Remove source" onClick={() => removeSource(index)} className="flex h-10 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"><X className="h-4 w-4" /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section className="border-t border-gray-200 pt-4">
                            <h3 className="mb-3 text-sm font-semibold text-gray-800">Connector source</h3>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div><ModalFieldLabel htmlFor="monitor-connector">Connector</ModalFieldLabel><ModalSelect id="monitor-connector" value={draft.connectorId ?? ""} options={[{ value: "", label: "Not enabled" }, ...(configuration?.connectors ?? []).map((connector) => ({ value: connector.id, label: connector.name }))]} onChange={(value) => {
                                    const connector = configuration?.connectors.find((candidate) => candidate.id === value);
                                    const trademarkAvailable = connector?.tools.some((tool) => tool.toolName === "tm_search_trademarks" && tool.enabled && !tool.requiresConfirmation) ?? false;
                                    const connectorText = connector ? [
                                        connector.name,
                                        connector.serverUrl,
                                        ...connector.tools.flatMap((tool) => [tool.toolName, tool.title ?? "", tool.description ?? ""]),
                                    ].join(" ").toLowerCase() : "";
                                    const dingDuff = connectorText.includes("dingduff") || connectorText.includes("ding-duff") || connectorText.includes("ding duff");
                                    setDraft((current) => ({
                                        ...current,
                                        connectorId: value || null,
                                        sourceTypes: dingDuff
                                            ? current.sourceTypes.length ? current.sourceTypes : ["case_law", "statutes"]
                                            : [],
                                        connectorConfig: current.connectorConfig.mode === "trademark_prefix" && !trademarkAvailable
                                            ? { mode: "agent" }
                                            : current.connectorConfig,
                                    }));
                                }} /></div>
                                <div><ModalFieldLabel htmlFor="monitor-model">Analysis model or committee</ModalFieldLabel><ModalSelect id="monitor-model" value={draft.model} options={modelOptions} onChange={(value) => setDraft((current) => ({ ...current, model: value }))} menuClassName="max-h-64" searchable searchPlaceholder="Search models..." /></div>
                            </div>
                            {draft.connectorId && <div className="mt-4 grid gap-4 sm:grid-cols-2">
                                <div><ModalFieldLabel htmlFor="monitor-connector-mode">Retrieval mode</ModalFieldLabel><ModalSelect id="monitor-connector-mode" value={draft.connectorConfig.mode} options={[
                                    { value: "agent", label: "Agent-directed research" },
                                    ...(supportsTrademarkPrefix ? [{ value: "trademark_prefix", label: "Trademark prefix watch" }] : []),
                                ]} onChange={(value) => setDraft((current) => ({
                                    ...current,
                                    connectorConfig: value === "trademark_prefix"
                                        ? { mode: "trademark_prefix", prefix: "", status: "live", internationalClass: null }
                                        : { mode: "agent" },
                                }))} /></div>
                            </div>}
                            {draft.connectorId && draft.connectorConfig.mode === "trademark_prefix" && <div className="mt-4 grid gap-4 sm:grid-cols-3">
                                <div><ModalFieldLabel htmlFor="monitor-trademark-prefix">Mark begins with</ModalFieldLabel><ModalTextInput id="monitor-trademark-prefix" value={draft.connectorConfig.prefix} maxLength={80} placeholder="ACME" onChange={(event) => {
                                    const prefix = event.target.value;
                                    setDraft((current) => current.connectorConfig.mode === "trademark_prefix"
                                        ? { ...current, connectorConfig: { ...current.connectorConfig, prefix } }
                                        : current);
                                }} /></div>
                                <div><ModalFieldLabel htmlFor="monitor-trademark-status">Registration status</ModalFieldLabel><ModalSelect id="monitor-trademark-status" value={draft.connectorConfig.status} options={[
                                    { value: "live", label: "Live" },
                                    { value: "all", label: "Live and dead" },
                                    { value: "dead", label: "Dead" },
                                ]} onChange={(value) => setDraft((current) => current.connectorConfig.mode === "trademark_prefix"
                                    ? { ...current, connectorConfig: { ...current.connectorConfig, status: value as "all" | "live" | "dead" } }
                                    : current)} /></div>
                                <div><ModalFieldLabel htmlFor="monitor-trademark-class">Nice class</ModalFieldLabel><ModalSelect id="monitor-trademark-class" value={draft.connectorConfig.internationalClass ?? ""} options={[
                                    { value: "", label: "All classes" },
                                    ...Array.from({ length: 45 }, (_, index) => ({ value: String(index + 1), label: `Class ${index + 1}` })),
                                ]} onChange={(value) => setDraft((current) => current.connectorConfig.mode === "trademark_prefix"
                                    ? { ...current, connectorConfig: { ...current.connectorConfig, internationalClass: value || null } }
                                    : current)} menuClassName="max-h-64" /></div>
                            </div>}
                            {draft.connectorId && draft.connectorConfig.mode === "agent" && selectedConnectorIsDingDuff && <div className="mt-3 flex flex-wrap gap-2">
                                {(["case_law", "statutes"] as LegalMonitorSourceType[]).map((source) => <SourceToggle key={source} label={sourceTypeLabel(source)} checked={draft.sourceTypes.includes(source)} disabled={!draft.connectorId} onChange={(checked) => setDraft((current) => ({ ...current, sourceTypes: checked ? [...current.sourceTypes, source] : current.sourceTypes.filter((item) => item !== source) }))} />)}
                            </div>}
                        </section>

                        <section className="grid gap-4 border-t border-gray-200 pt-4 sm:grid-cols-2 lg:grid-cols-3">
                            <div><ModalFieldLabel htmlFor="monitor-items">Maximum items per run</ModalFieldLabel><ModalSelect id="monitor-items" value={String(draft.maxItemsPerRun)} options={[10, 25, 50, 100].map((count) => ({ value: String(count), label: String(count) }))} onChange={(value) => setDraft((current) => ({ ...current, maxItemsPerRun: Number(value) }))} /></div>
                            <div><ModalFieldLabel htmlFor="monitor-threshold">Alert threshold</ModalFieldLabel><ModalSelect id="monitor-threshold" value={draft.materialityThreshold} options={LEGAL_MONITOR_SEVERITIES.map((severity) => ({ value: severity, label: `${severityLabel(severity)} and above` }))} onChange={(value) => setDraft((current) => ({ ...current, materialityThreshold: value as LegalMonitorSeverity }))} /><p className="mt-1 text-xs text-gray-400">Every development is recorded and ranked. Only those at or above this level are emailed.</p></div>
                            <div className="sm:col-span-2"><ToggleRow label="Email material updates" icon={<Mail className="h-4 w-4" />} checked={draft.emailEnabled} disabled={!configuration?.emailAvailable} onChange={(checked) => setDraft((current) => ({ ...current, emailEnabled: checked }))} />{draft.emailEnabled && <div className="mt-2"><ModalTextInput id="monitor-email" type="email" value={draft.alertEmail ?? ""} onChange={(event) => setDraft((current) => ({ ...current, alertEmail: event.target.value }))} /></div>}</div>
                            <div className="sm:col-span-2 lg:col-span-3"><ToggleRow label="Save run reports to Library" icon={<LibraryBig className="h-4 w-4" />} checked={draft.knowledgeCaptureEnabled} onChange={(checked) => setDraft((current) => ({ ...current, knowledgeCaptureEnabled: checked }))} />{draft.knowledgeCaptureEnabled && <p className="mt-1 text-xs text-gray-500">A living Markdown knowledgebase is kept in Library &rsaquo; Legal Monitors. Each run weaves new developments into it — valid prior knowledge is kept, superseded facts are corrected — and the assistant can read it or you can attach it as monitor context.</p>}</div>
                        </section>
                    </div>
                </div>
            </Modal>

            <Modal
                open={libraryPickerOpen}
                onClose={() => !libraryLoading && setLibraryPickerOpen(false)}
                size="lg"
                breadcrumbs={["Library", "Add context"]}
                primaryAction={{
                    label: "Add selected",
                    icon: <Check className="h-4 w-4" />,
                    onClick: confirmLibrarySelection,
                    disabled: libraryLoading || librarySelection.length > 10,
                }}
                cancelAction={{ label: "Cancel", onClick: () => setLibraryPickerOpen(false), disabled: libraryLoading }}
            >
                <div className="flex min-h-0 flex-1 flex-col">
                    {librarySelection.length > 10 && (
                        <div role="alert" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            Select no more than 10 files.
                        </div>
                    )}
                    <FileDirectory
                        documents={libraryDocuments}
                        loading={libraryLoading}
                        selectedDocuments={librarySelection}
                        onChange={setLibrarySelection}
                        showTabs={false}
                    />
                </div>
            </Modal>

            <Modal open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)} size="sm" breadcrumbs={["Delete monitor"]} primaryAction={{ label: deleting ? "Deleting" : "Delete", variant: "danger", icon: deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />, onClick: () => void removeMonitor(), disabled: deleting }} cancelAction={{ label: "Cancel", onClick: () => setConfirmDelete(false), disabled: deleting }}>
                <p className="py-6 text-sm leading-6 text-gray-600">Delete <strong>{selected?.name}</strong> and its source history and reports?</p>
            </Modal>
        </div>
    );
}

function MonitorDetail({ monitor, runs, selectedRun, selectedRunId, runsLoading, running, onSelectRun, onRun, onEdit, onToggle, onDelete }: {
    monitor: LegalMonitor; runs: LegalMonitorRun[]; selectedRun: LegalMonitorRun | null; selectedRunId: string | null;
    runsLoading: boolean; running: boolean; onSelectRun: (id: string) => void; onRun: () => void; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
    const unhealthy = monitor.sources.filter((source) => source.lastError);
    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-7">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2"><StatusPill monitor={monitor} running={running} /><span className="text-xs text-gray-400">{intervalLabel(monitor.intervalHours)}</span></div>
                    <h1 className="mt-2 break-words font-serif text-2xl text-gray-900">{monitor.name}</h1>
                    <p className="mt-2 max-w-3xl whitespace-pre-line text-sm leading-6 text-gray-500">{monitor.topic}</p>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                        <span>{monitor.jurisdiction}</span><span>{monitor.sources.length + (monitor.connectorName ? 1 : 0)} source{monitor.sources.length + (monitor.connectorName ? 1 : 0) === 1 ? "" : "s"}</span>{monitor.referenceDocuments.length > 0 && <span>{monitor.referenceDocuments.length} context file{monitor.referenceDocuments.length === 1 ? "" : "s"}</span>}{monitor.connectorName && <span>{monitor.connectorName}</span>}<span>Next: {dateTime(monitor.nextRunAt)}</span>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <PillButton tone="black" size="normal" onClick={onRun} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run now</PillButton>
                    <PillButton tone="white" size="normal" onClick={onEdit}><Pencil className="h-4 w-4" />Edit</PillButton>
                    <button type="button" aria-label={monitor.enabled ? "Pause monitor" : "Enable monitor"} title={monitor.enabled ? "Pause monitor" : "Enable monitor"} onClick={onToggle} className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100">{monitor.enabled ? <CirclePause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
                    <button type="button" aria-label="Delete monitor" title="Delete monitor" onClick={onDelete} className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
            </div>

            <section className="border-b border-gray-200 py-5">
                <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-gray-800">Sources</h2>{unhealthy.length > 0 && <span className="text-xs font-medium text-red-600">{unhealthy.length} need attention</span>}</div>
                <div className="grid gap-x-5 gap-y-1 lg:grid-cols-2">
                    {monitor.sources.map((source) => (
                        <div key={source.id} className="flex min-w-0 items-center gap-3 border-b border-gray-100 py-2.5">
                            {source.kind === "rss" ? <Rss className="h-4 w-4 shrink-0 text-orange-500" /> : <Globe2 className="h-4 w-4 shrink-0 text-blue-600" />}
                            <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><p className="truncate text-sm font-medium text-gray-700">{source.name}</p>{source.category && <span className="truncate text-[11px] text-gray-400">{source.category}</span>}</div><p className={cn("mt-0.5 truncate text-xs", source.lastError ? "text-red-600" : "text-gray-400")}>{!source.enabled ? "Disabled" : source.lastError || `${source.itemCount} items · checked ${dateTime(source.lastCheckedAt)}`}</p></div>
                            <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.name}`} className="text-gray-400 hover:text-gray-700"><ExternalLink className="h-3.5 w-3.5" /></a>
                        </div>
                    ))}
                    {monitor.connectorName && <div className="flex items-center gap-3 border-b border-gray-100 py-2.5"><FileSearch className="h-4 w-4 text-emerald-600" /><div className="min-w-0"><p className="text-sm font-medium text-gray-700">{monitor.connectorName}</p><p className="truncate text-xs text-gray-400">{connectorConfigLabel(monitor.connectorConfig, monitor.sourceTypes)}</p></div></div>}
                </div>
            </section>

            {monitor.referenceDocuments.length > 0 && (
                <section className="border-b border-gray-200 py-5">
                    <h2 className="mb-3 text-sm font-semibold text-gray-800">Library context</h2>
                    <div className="grid gap-x-5 gap-y-1 lg:grid-cols-2">
                        {monitor.referenceDocuments.map((document) => (
                            <div key={document.id} className="flex min-w-0 items-center gap-3 border-b border-gray-100 py-2.5">
                                <FileText className="h-4 w-4 shrink-0 text-blue-600" />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-gray-700">{document.filename}</p>
                                    <p className="text-xs text-gray-400">{document.fileType?.toUpperCase() || "File"}{document.versionNumber ? ` · V${document.versionNumber}` : ""}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <div className="grid gap-7 py-5 lg:grid-cols-[210px_minmax(0,1fr)]">
                <section><h2 className="mb-3 text-xs font-semibold uppercase text-gray-400">Run history</h2>{runsLoading ? <LoadingState /> : runs.length ? <div className="space-y-1">{runs.map((run) => <button key={run.id} type="button" onClick={() => onSelectRun(run.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left", selectedRunId === run.id ? "bg-gray-100" : "hover:bg-gray-50")}><RunStatusIcon run={run} /><div className="min-w-0"><p className="truncate text-xs font-medium text-gray-700">{dateTime(run.startedAt)}</p><p className="truncate text-[11px] text-gray-400">{run.sourceItemCount} source items · {run.developments.length} updates</p></div></button>)}</div> : <p className="text-sm text-gray-400">No runs yet.</p>}</section>
                <section>{selectedRun ? <RunReport run={selectedRun} /> : <div className="border-l-2 border-gray-100 py-8 pl-5"><Clock3 className="h-5 w-5 text-gray-300" /><p className="mt-2 text-sm text-gray-400">Run the monitor to create its first report.</p></div>}</section>
            </div>
        </div>
    );
}

function SourceToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
    return <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cn("inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm", checked ? "border-blue-200 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-500", disabled && "cursor-not-allowed opacity-40")}><span className={cn("flex h-4 w-4 items-center justify-center rounded-sm border", checked ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300")}>{checked && <Check className="h-3 w-3" />}</span>{label}</button>;
}

function ToggleRow({ label, icon, checked, disabled, onChange }: { label: string; icon: React.ReactNode; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
    return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="flex h-10 w-full items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-40"><span className="text-gray-500">{icon}</span><span className="flex-1 text-sm font-medium text-gray-700">{label}</span><span className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-gray-800" : "bg-gray-200")}><span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} /></span></button>;
}

function RunReport({ run }: { run: LegalMonitorRun }) {
    const sourceErrors = run.sourceErrors ?? [];
    return <div><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-gray-400">{dateTime(run.completedAt)}</p><h2 className="mt-1 font-serif text-xl text-gray-900">{run.hasMaterialUpdates ? `${run.developments.length} material development${run.developments.length === 1 ? "" : "s"}${run.developments.length ? ` · highest ${severityLabel(run.developments[0].severity).toLowerCase()}` : ""}` : "No material updates"}</h2></div><div className="flex flex-wrap gap-2 text-xs text-gray-500"><span className="rounded-md bg-gray-100 px-2 py-1">{run.sourceItemCount} source items</span>{run.toolCalls > 0 && <span className="rounded-md bg-gray-100 px-2 py-1">{run.toolCalls} connector calls</span>}{run.emailStatus === "sent" && <span className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700">Alert sent</span>}</div></div>{run.error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{run.error}</div>}{sourceErrors.length > 0 && <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><p className="font-semibold">Source errors</p>{sourceErrors.map((sourceError) => <p key={sourceError} className="mt-1 break-words">{sourceError}</p>)}</div>}{run.summary && <p className="mt-4 text-sm font-medium leading-6 text-gray-700">{run.summary}</p>}{run.developments.length > 0 && <div className="mt-5 divide-y divide-gray-100 border-y border-gray-200">{run.developments.map((development, index) => <div key={`${development.url ?? development.title}-${index}`} className="py-4"><div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-sm font-semibold text-gray-800">{development.title}</h3>{development.url && <a href={development.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600">Source<ExternalLink className="h-3 w-3" /></a>}</div><p className="mt-1 text-xs text-gray-400"><span className={cn("font-medium", SEVERITY_TEXT_CLASS[development.severity] ?? SEVERITY_TEXT_CLASS.medium)}>{severityLabel(development.severity)}</span>{[development.sourceName, development.citation, development.date].filter(Boolean).length > 0 && <span> · {[development.sourceName, development.citation, development.date].filter(Boolean).join(" · ")}</span>}{typeof development.confidence === "number" && development.confidence < 0.5 && <span> · low confidence</span>}</p>{development.unverified?.length > 0 && <p className="mt-1 text-xs text-amber-700">Unverified: {development.unverified.join("; ")}. Check the linked source before relying on this.</p>}<p className="mt-2 text-sm leading-6 text-gray-600">{development.whyItMatters}</p></div>)}</div>}{run.report && <div className="legal-monitor-markdown prose prose-sm mt-6 max-w-none font-serif text-gray-800"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => defaultUrlTransform(url)}>{run.report}</ReactMarkdown></div>}</div>;
}

function StatusPill({ monitor, running }: { monitor: LegalMonitor; running: boolean }) {
    const label = running ? "Running" : !monitor.enabled ? "Paused" : monitor.lastStatus === "failed" ? "Needs attention" : "Active";
    return <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium", label === "Needs attention" ? "bg-red-50 text-red-700" : label === "Active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600")}>{running ? <Loader2 className="h-3 w-3 animate-spin" /> : label === "Active" ? <Bell className="h-3 w-3" /> : <CirclePause className="h-3 w-3" />}{label}</span>;
}

function RunStatusIcon({ run }: { run: LegalMonitorRun }) {
    if (run.status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />;
    if (run.status === "failed") return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />;
    return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
}

function StatusDot({ status, enabled }: { status: LegalMonitor["lastStatus"]; enabled: boolean }) {
    return <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", !enabled ? "bg-gray-300" : status === "failed" ? "bg-red-500" : status === "running" ? "bg-blue-500" : "bg-emerald-500")} />;
}

function LoadingState() {
    return <div className="flex items-center gap-2 py-4 text-xs text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Loading</div>;
}

function referenceDocumentToDocument(
    document: LegalMonitor["referenceDocuments"][number],
): Document {
    return {
        id: document.id,
        project_id: null,
        filename: document.filename,
        file_type: document.fileType,
        storage_path: "library-reference",
        pdf_storage_path: null,
        size_bytes: document.sizeBytes,
        page_count: null,
        structure_tree: null,
        status: document.status === "ready" ? "ready" : "error",
        created_at: document.updatedAt,
        updated_at: document.updatedAt,
        active_version_number: document.versionNumber,
    };
}
