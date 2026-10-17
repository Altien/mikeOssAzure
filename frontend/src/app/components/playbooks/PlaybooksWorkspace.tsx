"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";
import {
  AlertCircle,
  Check,
  Cloud,
  FilePlus2,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import {
  PlaybookActionItems,
  PlaybookTable,
  playbookPath,
  type PlaybookActionHandlers,
} from "@/app/components/playbooks/PlaybookTable";
import { PlaybookEditor } from "@/app/components/playbooks/PlaybookEditor";
import {
  PLAYBOOK_VIEWS,
  PlaybookToolbar,
  type PlaybookView,
} from "@/app/components/playbooks/PlaybookToolbar";
import { PlaybookOverview } from "@/app/components/playbooks/PlaybookOverview";
import { PlaybookPageSkeleton } from "@/app/components/playbooks/PlaybookPageSkeleton";
import {
  PlaybookReviewDocuments,
  type ReviewDocument,
} from "@/app/components/playbooks/PlaybookReviewDocuments";
import { PlaybookRuns } from "@/app/components/playbooks/PlaybookRuns";
import { PlaybookRunsTable } from "@/app/components/playbooks/PlaybookRunsTable";
import {
  PlaybookSources,
  type PlaybookSourcesHandle,
} from "@/app/components/playbooks/PlaybookSources";
import { createPlaybookRule } from "@/app/components/playbooks/playbookRules";
import {
  PlaybookField,
  PlaybookListField,
} from "@/app/components/playbooks/PlaybookField";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { Modal } from "@/app/components/modals/Modal";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { PillButtonUI as PillButton } from "@/shared/ui/PillButtonUI";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { modelDisplayName, SETTINGS_MODELS } from "@/shared/lib/modelCatalog";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";
import { usePathParams } from "@/app/lib/usePathParams";
import { useModelApiKeys } from "@/app/hooks/useModelApiKeys";
import { buildPlaybookModelOptions } from "@/app/components/playbooks/playbookModelOptions";
import {
  getDocumentFile,
  createPlaybook,
  deletePlaybook,
  getPlaybookConfiguration,
  importPlaybook,
  listPlaybooks,
  getPlaybookPeople,
  listPlaybookShares,
  sharePlaybook,
  revokePlaybookShare,
  reviewDocumentWithPlaybook,
  uploadLibraryDocument,
  type Playbook,
  type PlaybookShare,
  type PlaybookContent,
  type PlaybookConfiguration,
  type PlaybookRun,
} from "@/app/lib/mikeApi";

import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useWorkspaceIdentity } from "@/app/hooks/useWorkspaceIdentity";
import { usePlaybookAutosave } from "@/app/hooks/usePlaybookAutosave";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useAuth } from "@/app/contexts/AuthContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Document } from "@/app/components/shared/types";

function isWordDocument(filename: string) {
  return filename.toLowerCase().endsWith(".docx");
}

async function extractReviewText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() })
      .promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        (content.items as Array<{ str?: string }>)
          .map((item) => item.str ?? "")
          .join(" "),
      );
    }
    return pages
      .map((text, index) => `[Page ${index + 1}]\n${text}`)
      .join("\n\n");
  }
  return file.text();
}

const LIST_TABS = ["all", "mine", "shared", "runs"] as const;
type ListTab = (typeof LIST_TABS)[number];

const DEFAULT_REVIEW_INSTRUCTIONS =
  "Run a complete playbook review. Prioritize unacceptable and missing-required terms, quote exact contract language, and provide complete replacement language for issues that need revision.";

/**
 * Rendered by the playbooks layout, so moving between the list and a
 * playbook keeps the loaded list and any pending autosave.
 */
export function PlaybooksWorkspaceLayout() {
  const identity = useWorkspaceIdentity();
  return <PlaybooksWorkspace key={identity} />;
}

function PlaybooksWorkspace() {
  const { workspaceId, activeOrganization } = useWorkspace();
  const router = useRouter();
  const params = usePathParams<"playbookId">("/playbooks/:playbookId");
  const routeId =
    params.playbookId || null;
  const isOrganization = !!workspaceId && workspaceId !== "personal";
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { user } = useAuth();
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessTargetId, setAccessTargetId] = useState<string | null>(null);
  const [shares, setShares] = useState<PlaybookShare[]>([]);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [savedFilesOpen, setSavedFilesOpen] = useState(false);
  const reviewFileRef = useRef<HTMLInputElement>(null);
  const openingDocumentPicker = useRef(false);
  const apiKeys = useModelApiKeys();
  const configuredModels = useConfiguredModels();
  const configuredModelOptions = useMemo(
    () => [
      ...SETTINGS_MODELS,
      ...configuredModels.map((model) => ({
        ...model,
        label: modelDisplayName(model.id),
        source: "Configured" as const,
      })),
    ],
    [configuredModels],
  );
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  // The URL decides which playbook is open; selection follows it at once so
  // the editor does not wait for navigation to finish.
  const [selectedId, setSelectedId] = useState<string | null>(routeId);
  const [syncedRouteId, setSyncedRouteId] = useState(routeId);
  if (syncedRouteId !== routeId) {
    setSyncedRouteId(routeId);
    setSelectedId(routeId);
  }
  const [content, setContent] = useState<PlaybookContent | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  // Each tab is in the URL (?tab=), on the list and on a playbook alike. Only
  // the page being shown keeps its own value in the URL.
  const [tab, setTab] = useQueryParamTab(LIST_TABS, "all", false, !routeId);
  const [playbookView, setPlaybookView] = useQueryParamTab(
    PLAYBOOK_VIEWS,
    "rules",
    false,
    !!routeId,
  );
  // Back from a playbook returns to the list tab it was opened from.
  const lastListTab = useRef<ListTab>("all");
  useEffect(() => {
    if (!routeId) lastListTab.current = tab;
  }, [routeId, tab]);
  // A run chosen from the list of all runs, opened on its playbook's Runs tab.
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const sourcesRef = useRef<PlaybookSourcesHandle>(null);
  const [search, setSearch] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [configuration, setConfiguration] =
    useState<PlaybookConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Set when the Word file replaces an existing playbook's content.
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDocuments, setReviewDocuments] = useState<ReviewDocument[]>([]);
  const [reviewInstructions, setReviewInstructions] = useState(
    DEFAULT_REVIEW_INSTRUCTIONS,
  );
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"strict" | "permissive">(
    "strict",
  );
  const [run, setRun] = useState<PlaybookRun | null>(null);

  const autosave = usePlaybookAutosave(
    useCallback((saved: Playbook) => {
      setPlaybooks((items) =>
        items.map((item) => (item.id === saved.id ? saved : item)),
      );
    }, []),
  );
  const selected = playbooks.find((item) => item.id === selectedId) ?? null;
  const accessPlaybook =
    playbooks.find((item) => item.id === accessTargetId) ?? null;
  // A playbook being opened (by a link, a refresh, or from the table) shows a
  // playbook page while it loads, not the table. It follows the selection
  // rather than the URL, which still names the playbook just after Back.
  const linkedPlaybookLoading =
    !!selectedId &&
    !(selected && content) &&
    !error &&
    (loading || playbooks.some((item) => item.id === selectedId));
  const selectedLoaded = !!selected;

  function openPlaybook(
    id: string | null,
    options: { replace?: boolean; tab?: PlaybookView } = {},
  ) {
    setSelectedId(id);
    if (id === routeId) return;
    const path = id
      ? `${playbookPath(id)}${options.tab ? `?tab=${options.tab}` : ""}`
      : lastListTab.current === "all"
        ? "/playbooks"
        : `/playbooks?tab=${lastListTab.current}`;
    if (options.replace) router.replace(path);
    else router.push(path);
  }
  const visiblePlaybooks = playbooks.filter((item) => {
    const matchesTab =
      tab === "all" ||
      (isOrganization
        ? tab === "shared"
          ? item.visibility === "organization"
          : item.visibility !== "organization"
        : tab === "shared"
          ? !item.isCreator
          : item.isCreator);
    return (
      matchesTab &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });
  const canEdit = !!selected && selected.canEdit === true;
  const canManageAccess = !!selected && selected.canManageAccess === true;
  const checkedPlaybooks = visiblePlaybooks.filter((item) =>
    selectedIds.has(item.id),
  );
  const deleteTargets = deleteTargetId
    ? playbooks.filter((item) => item.id === deleteTargetId)
    : selected
      ? [selected]
      : checkedPlaybooks;

  function changeContent(
    next: PlaybookContent,
    access: Pick<Playbook, "visibility"> = {
      visibility: selected?.visibility ?? "private",
    },
  ) {
    if (!selected || !canEdit) return;
    setContent(next);
    autosave.schedule({ id: selected.id, content: next, access });
  }

  function changeAccess(access: Pick<Playbook, "visibility">) {
    if (!selected || !content || !canManageAccess) return;
    setPlaybooks((items) =>
      items.map((item) =>
        item.id === selected.id ? { ...item, ...access } : item,
      ),
    );
    changeContent(content, access);
  }

  /**
   * Re-read the grants after a change the server accepted, and say so when
   * the read fails rather than show the roles as they were before.
   */
  const refreshShares = useCallback(async (playbookId: string) => {
    try {
      const next = await listPlaybookShares(playbookId);
      setShares(next);
      setSharesError(null);
      // The table's Access column counts the people it is shared with.
      setPlaybooks((items) =>
        items.map((item) =>
          item.id === playbookId
            ? {
                ...item,
                sharedWith: next
                  .filter((share) => share.role !== "deny")
                  .map((share) => share.shared_with_email),
              }
            : item,
        ),
      );
    } catch (error) {
      setSharesError(
        userFacingApiError(
          error,
          "The change was saved, but this list could not be reloaded. Reopen People to see the current one.",
        ),
      );
    }
  }, []);

  function openAccess(playbook: Playbook) {
    if (busy) return;
    setAccessTargetId(playbook.id);
    setShares([]);
    setSharesError(null);
    setAccessOpen(true);
    if (playbook.canManageAccess) void refreshShares(playbook.id);
  }

  function addRule() {
    if (!content || !canEdit || busy) return;
    const rules = content.rules ?? [];
    const count =
      rules.length +
      content.topics.reduce((total, topic) => total + topic.rules.length, 0);
    const rule = createPlaybookRule(count + 1);
    changeContent({ ...content, rules: [...rules, rule] });
    setSelectedRuleId(rule.id);
  }

  async function backToList() {
    if (busy || !(await autosave.flush())) return;
    setDeleteOpen(false);
    openPlaybook(null);
  }

  const models = useMemo(
    () =>
      buildPlaybookModelOptions(configuredModelOptions, configuration, apiKeys),
    [configuration, configuredModelOptions, apiKeys],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, configuration] = await Promise.all([
        listPlaybooks(workspaceId),
        getPlaybookConfiguration(workspaceId),
      ]);
      setPlaybooks(items);
      setConfiguration(configuration);
      setSelectedId((current) =>
        current && items.some((item) => item.id === current) ? current : null,
      );
    } catch (err) {
      setError(describeError(err, { action: "load playbooks" }).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setModel((current) => {
      if (models.some((entry) => entry.value === current)) return current;
      if (
        configuration?.defaultModel &&
        models.some((entry) => entry.value === configuration.defaultModel)
      ) {
        return configuration.defaultModel;
      }
      return models[0]?.value ?? "";
    });
  }, [configuration?.defaultModel, models]);
  useEffect(() => {
    // The run belongs to the playbook it was produced from. Clear it with the
    // rest of the selection, or the previous playbook's summary and findings
    // render under the next playbook's heading.
    setRun(null);
    autosave.resetStatus();
    setReviewDocuments([]);
    if (!selected) {
      setContent(null);
      setSelectedRuleId(null);
      return;
    }
    setContent(structuredClone(selected.content));
    setSelectedRuleId(null);
    // A link opens before the list loads, so also run once the playbook arrives.
  }, [selectedId, selectedLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A link to a deleted playbook, or one in another workspace, shows the list.
    if (
      routeId &&
      !loading &&
      !error &&
      !playbooks.some((item) => item.id === routeId)
    )
      router.replace("/playbooks");
  }, [routeId, loading, error, playbooks, router]);

  function openImport(targetId: string | null) {
    setImportTargetId(targetId);
    setImportFile(null);
    setImportName("");
    setImportError(null);
    setImportOpen(true);
  }

  async function startBlank() {
    setBusy("create");
    setError(null);
    try {
      const created = await createPlaybook(undefined, workspaceId);
      setPlaybooks((current) => [created, ...current]);
      openPlaybook(created.id, { tab: "overview" });
    } catch (err) {
      notifyError(err, { action: "create the playbook" });
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    if (!importFile) return;
    setBusy("import");
    setError(null);
    setImportError(null);
    try {
      if (!(await autosave.flush())) return;
      const saved = await importPlaybook(
        importFile,
        model,
        importName,
        importTargetId ?? undefined,
        workspaceId,
      );
      setPlaybooks((current) =>
        importTargetId
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...current],
      );
      openPlaybook(saved.id);
      // Replacing the selected playbook does not change selectedId, so the
      // selection effect will not run. Load the rewritten content here.
      setContent(structuredClone(saved.content));
      setEditorRevision((current) => current + 1);
      setSelectedRuleId(null);
      setImportOpen(false);
      setImportFile(null);
      setImportName("");
      setImportTargetId(null);
    } catch (err) {
      setImportError(
        describeError(err, { action: "import the playbook" }).message,
      );
    } finally {
      setBusy(null);
    }
  }

  function requestDelete(targetId?: string) {
    const targets = targetId
      ? playbooks.filter((item) => item.id === targetId)
      : selected
        ? [selected]
        : checkedPlaybooks;
    if (
      busy ||
      !targets.length ||
      targets.some((item) => !item.canManageAccess)
    )
      return;
    setDeleteTargetId(targetId ?? null);
    setDeleteOpen(true);
  }

  const tableActions: PlaybookActionHandlers = {
    onOpen: (id) => {
      setSelectedIds(new Set());
      setFocusRunId(null);
      openPlaybook(id);
    },
    onDetails: (id) => {
      setSelectedIds(new Set());
      setFocusRunId(null);
      openPlaybook(id, { tab: "overview" });
    },
    onRun: (id) => {
      setSelectedIds(new Set());
      setFocusRunId(null);
      setReviewError(null);
      openPlaybook(id);
      setReviewOpen(true);
    },
    onPeople: openAccess,
    onDelete: requestDelete,
    onDeleteSelected: () => requestDelete(),
  };

  async function remove() {
    const targets = deleteTargets;
    if (!targets.length || targets.some((item) => !item.canManageAccess))
      return;
    setBusy("delete");
    try {
      if (!(await autosave.flush())) return;
      for (const target of targets) {
        await deletePlaybook(target.id);
        setPlaybooks((items) => items.filter((item) => item.id !== target.id));
        setSelectedIds(
          (ids) => new Set([...ids].filter((id) => id !== target.id)),
        );
      }
      if (selected) openPlaybook(null, { replace: true });
      setDeleteOpen(false);
      setDeleteTargetId(null);
    } catch (err) {
      notifyError(err, { action: "delete the playbook" });
    } finally {
      setBusy(null);
    }
  }

  const pendingReviewDocuments = reviewDocuments.filter(
    (item) => item.status !== "completed",
  );

  function addReviewDocuments(candidates: ReviewDocument[]) {
    if (busy) return;
    const supported = candidates.filter((item) =>
      /\.(pdf|docx|txt)$/i.test(item.name),
    );
    setReviewError(
      supported.length < candidates.length
        ? "Some files weren’t added. Choose PDF, DOCX, or TXT documents."
        : null,
    );
    setReviewDocuments((current) => {
      const ids = new Set(current.map((item) => item.id));
      return [
        ...current,
        ...supported.filter((item) => {
          if (ids.has(item.id)) return false;
          ids.add(item.id);
          return true;
        }),
      ];
    });
  }

  function addReviewFiles(files: File[]) {
    addReviewDocuments(
      files.map((file) => ({
        id: JSON.stringify(["upload", file.name, file.size, file.lastModified]),
        name: file.name,
        kind: "upload",
        file,
        status: "ready",
      })),
    );
  }

  async function review() {
    if (!selected || !pendingReviewDocuments.length || busy) return;
    setBusy("review");
    setError(null);
    setReviewError(null);
    try {
      if (!(await autosave.flush())) return;
      let failed = false;
      for (const item of pendingReviewDocuments) {
        setReviewDocuments((items) =>
          items.map((document) =>
            document.id === item.id
              ? { ...document, status: "reviewing", error: undefined }
              : document,
          ),
        );
        try {
          // Every reviewed document is stored, so a Word document can take
          // the review's tracked changes: an upload is saved to Library Files.
          let documentId: string;
          let documentText: string | undefined;
          let documentName: string;
          if (item.kind === "saved") {
            documentId = item.document.id;
            documentName = item.document.filename || item.name;
            if (!isWordDocument(documentName)) {
              const { blob, filename } = await getDocumentFile(
                item.document.id,
                item.document.current_version_id,
              );
              documentText = await extractReviewText(
                new File([blob], filename || documentName, { type: blob.type }),
              );
            }
          } else {
            const stored = await uploadLibraryDocument(
              { kind: "files", workspace: workspaceId ?? "personal" },
              item.file,
            );
            documentId = stored.id;
            documentName = item.file.name;
            if (!isWordDocument(documentName))
              documentText = await extractReviewText(item.file);
          }
          // A Word document is read by the server, from the stored file.
          const result = await reviewDocumentWithPlaybook(selected.id, {
            documentId,
            documentText,
            documentName,
            instructions: reviewInstructions,
            model,
            reviewMode,
          });
          setRun(result);
          setReviewDocuments((items) =>
            items.map((document) =>
              document.id === item.id
                ? { ...document, status: "completed", error: undefined }
                : document,
            ),
          );
        } catch (err) {
          failed = true;
          const error = describeError(err, {
            action: "review the document",
          }).message;
          setReviewDocuments((items) =>
            items.map((document) =>
              document.id === item.id
                ? { ...document, status: "failed", error }
                : document,
            ),
          );
        }
      }
      if (!failed) {
        setReviewDocuments([]);
        setReviewOpen(false);
        setPlaybookView("runs");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader
        shrink
        breadcrumbs={
          linkedPlaybookLoading
            ? [
                { label: "Playbooks", onClick: () => openPlaybook(null) },
                { loading: true, skeletonClassName: "w-40" },
              ]
            : selected
              ? [
                  {
                    label: "Playbooks",
                    onClick: () => void backToList(),
                  },
                  {
                    label: content?.name || selected.name,
                    title: content?.name || selected.name,
                  },
                ]
              : [{ label: "Playbooks" }]
        }
        actionGroups={
          linkedPlaybookLoading
            ? []
            : selected
              ? [
                  autosave.status !== "idle"
                    ? [
                        {
                          type: "custom" as const,
                          render: (
                            <span
                              role="status"
                              className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm ${autosave.status === "error" ? "text-red-600" : "text-gray-500"}`}
                            >
                              {autosave.status === "saved" && (
                                <Check
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5 text-green-600"
                                />
                              )}
                              {autosave.status === "saving"
                                ? "Saving…"
                                : autosave.status === "error"
                                  ? "Couldn’t save"
                                  : "Saved"}
                            </span>
                          ),
                        },
                      ]
                    : [],
                  [
                    {
                      onClick: () => openAccess(selected),
                      title: "Playbook people",
                      iconOnly: true,
                      icon: <Users aria-hidden="true" className="h-4 w-4" />,
                    },
                    {
                      type: "custom",
                      render: (
                        <Dropdown>
                          <DropdownTrigger asChild>
                            <HeaderButtonUI
                              iconOnly
                              aria-label="Playbook actions"
                              disabled={!!busy || !canEdit}
                            >
                              <MoreHorizontal
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </HeaderButtonUI>
                          </DropdownTrigger>
                          <DropdownContent align="end" className="w-52">
                            <DropdownItem
                              onSelect={() => openImport(selected.id)}
                            >
                              <RefreshCw
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                              Replace from Word
                            </DropdownItem>
                            {canManageAccess && (
                              <DropdownItem
                                variant="destructive"
                                onSelect={() => requestDelete()}
                              >
                                <Trash2
                                  aria-hidden="true"
                                  className="h-4 w-4"
                                />
                                Delete playbook
                              </DropdownItem>
                            )}
                          </DropdownContent>
                        </Dropdown>
                      ),
                    },
                  ],
                  [
                    {
                      icon: <Play aria-hidden="true" className="h-3.5 w-3.5" />,
                      label: "Run",
                      disabled: !!busy,
                      onClick: () => setReviewOpen(true),
                    },
                  ],
                ]
              : [
                  [
                    {
                      type: "search",
                      value: search,
                      onChange: setSearch,
                      placeholder:
                        tab === "runs" ? "Search runs…" : "Search playbooks…",
                    },
                    {
                      type: "custom",
                      render: (
                        <NewPlaybookMenu
                          disabled={loading || !!busy}
                          onImport={() => openImport(null)}
                          onBlank={() => void startBlank()}
                        />
                      ),
                    },
                  ],
                ]
        }
      />
      {linkedPlaybookLoading ? (
        <PlaybookPageSkeleton />
      ) : selected && content ? (
        <>
          <PlaybookToolbar
            disabled={!!busy}
            canEdit={canEdit}
            view={playbookView}
            onViewChange={setPlaybookView}
            onAddRule={addRule}
            onUpload={() => sourcesRef.current?.upload()}
          />
          {playbookView === "overview" ? (
            <PlaybookOverview
              playbook={selected}
              ruleCount={
                (content.rules?.length ?? 0) +
                content.topics.reduce(
                  (sum, topic) => sum + topic.rules.length,
                  0,
                )
              }
              workspaceName={activeOrganization?.name ?? null}
            >
              <fieldset
                disabled={!canEdit || !!busy}
                className="grid min-w-0 gap-4 @[32rem]:grid-cols-2"
              >
                <legend className="sr-only">Playbook details</legend>
                <PlaybookField
                  label="Playbook name"
                  value={content.name}
                  onChange={(name) => changeContent({ ...content, name })}
                />
                <PlaybookField
                  label="Represented party"
                  value={content.representedParty}
                  onChange={(representedParty) =>
                    changeContent({ ...content, representedParty })
                  }
                />
                <PlaybookListField
                  label="Document types"
                  value={content.documentTypes}
                  placeholder="NDA, MSA"
                  onChange={(documentTypes) =>
                    changeContent({ ...content, documentTypes })
                  }
                />
                <PlaybookListField
                  label="Jurisdictions"
                  value={content.jurisdictions}
                  placeholder="England and Wales, New York"
                  onChange={(jurisdictions) =>
                    changeContent({ ...content, jurisdictions })
                  }
                />
                <div className="@[32rem]:col-span-2">
                  <PlaybookField
                    label="Description"
                    value={content.description}
                    onChange={(description) =>
                      changeContent({ ...content, description })
                    }
                    multiline
                  />
                </div>
                <div className="@[32rem]:col-span-2">
                  <PlaybookField
                    label="Global guidance"
                    value={content.globalGuidance}
                    onChange={(globalGuidance) =>
                      changeContent({ ...content, globalGuidance })
                    }
                    multiline
                  />
                </div>
              </fieldset>
              {isOrganization && (
                <div>
                  <ModalFieldLabel htmlFor="playbook-visibility">
                    Access
                  </ModalFieldLabel>
                  <ModalSelect
                    id="playbook-visibility"
                    variant="flat"
                    value={selected.visibility ?? "private"}
                    disabled={!canManageAccess || !!busy}
                    options={[
                      { value: "private", label: "Private" },
                      { value: "organization", label: "Public" },
                    ]}
                    onChange={(visibility) =>
                      changeAccess({
                        visibility: visibility as Playbook["visibility"],
                      })
                    }
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    Members can view and run a public playbook. Choose who can
                    edit it from People.
                  </p>
                </div>
              )}
            </PlaybookOverview>
          ) : playbookView === "runs" ? (
            <PlaybookRuns
              key={selected.id}
              playbookId={selected.id}
              latestRun={run}
              initialRunId={focusRunId}
              canRun={!busy}
              onRun={() => setReviewOpen(true)}
            />
          ) : playbookView === "references" ? (
            <PlaybookSources
              ref={sourcesRef}
              key={selected.id}
              playbookId={selected.id}
              sourceFilename={selected.sourceFilename}
              revision={`${editorRevision}:${selected.sourceFilename ?? ""}`}
              canEdit={canEdit && !busy}
            />
          ) : (
            <PlaybookEditor
              key={`${selected.id}:${editorRevision}`}
              content={content}
              onChange={changeContent}
              selectedRuleId={selectedRuleId}
              onSelectRule={setSelectedRuleId}
              disabled={!!busy || !canEdit}
            ></PlaybookEditor>
          )}
        </>
      ) : (
        <>
          <TableToolbar
            items={
              isOrganization
                ? [
                    { id: "all", label: "All" },
                    { id: "mine", label: "Private" },
                    { id: "shared", label: "Public" },
                    { id: "runs", label: "Runs" },
                  ]
                : [
                    { id: "all", label: "All" },
                    { id: "mine", label: "My playbooks" },
                    { id: "shared", label: "Shared with me" },
                    { id: "runs", label: "Runs" },
                  ]
            }
            active={tab}
            onChange={(next) => {
              setTab(next as ListTab);
              setSelectedIds(new Set());
            }}
            actions={
              // One "Actions" menu for the selection, as on other tables.
              checkedPlaybooks.length > 0 && tab !== "runs" ? (
                <SelectionActionsMenu
                  renderItems={(close) => (
                    <PlaybookActionItems
                      {...tableActions}
                      playbooks={checkedPlaybooks}
                      disabled={!!busy}
                      onActionChosen={close}
                      onDeselect={() => setSelectedIds(new Set())}
                    />
                  )}
                />
              ) : undefined
            }
          />
          {tab === "runs" ? (
            <PlaybookRunsTable
              workspaceId={workspaceId}
              search={search}
              disabled={!!busy}
              onOpen={(item) => {
                setFocusRunId(item.id);
                openPlaybook(item.playbookId, { tab: "runs" });
              }}
            />
          ) : (
            <PlaybookTable
              playbooks={visiblePlaybooks}
              loading={loading}
              error={error}
              filtered={!!search.trim()}
              emptyContext={
                tab === "all"
                  ? "all"
                  : isOrganization
                    ? tab === "shared"
                      ? "public"
                      : "private"
                    : tab === "shared"
                      ? "shared"
                      : "mine"
              }
              disabled={!!busy}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              {...tableActions}
              onRetry={() => void load()}
              onImport={() => openImport(null)}
              onCreate={() => void startBlank()}
            />
          )}
        </>
      )}
      {accessPlaybook && accessOpen && (
        <AccessModal
          open={accessOpen}
          onClose={() => setAccessOpen(false)}
          resource={{ id: accessPlaybook.id }}
          fetchAccess={getPlaybookPeople}
          currentUserEmail={user?.email ?? null}
          currentUserId={user?.id ?? null}
          breadcrumb={[
            "Playbooks",
            accessPlaybook.name || "Untitled playbook",
            "Access",
          ]}
          access={{
            grants: shares.map((share) => ({
              email: share.shared_with_email,
              role: share.role,
            })),
            orgId: accessPlaybook.orgId,
            ownerLabel: "Playbook owners",
            resourceNoun: "playbook",
            canManage: accessPlaybook.canManageAccess,
            visibility: accessPlaybook.visibility,
            // Members can view and run a public playbook; editing is given
            // person by person.
            publicMemberRole: "viewer",
            error: sharesError,
            onGrant: async (email, role) => {
              await sharePlaybook(accessPlaybook.id, { emails: [email], role });
              await refreshShares(accessPlaybook.id);
            },
            onRevoke: async (email) => {
              const share = shares.find(
                (entry) =>
                  entry.shared_with_email.trim().toLowerCase() ===
                  email.trim().toLowerCase(),
              );
              if (share) await revokePlaybookShare(accessPlaybook.id, share.id);
              await refreshShares(accessPlaybook.id);
            },
          }}
        />
      )}
      <AddDocumentsModal
        open={savedFilesOpen}
        onClose={() => setSavedFilesOpen(false)}
        breadcrumb={["Playbooks", "Saved files"]}
        uploadStateId="playbook-review"
        onSelect={(documents) => {
          setSavedFilesOpen(false);
          addReviewDocuments(
            documents.map((document: Document) => ({
              id: JSON.stringify([
                "saved",
                document.id,
                document.current_version_id,
              ]),
              name: document.filename,
              kind: "saved",
              document,
              status: "ready",
            })),
          );
        }}
      />
      <ConfirmPopup
        open={deleteOpen}
        title={
          deleteTargets.length === 1 ? "Delete playbook?" : "Delete playbooks?"
        }
        message={
          deleteTargets.length === 1
            ? `“${deleteTargets[0].name}” and its rules will be deleted.`
            : `${deleteTargets.length} selected playbooks and their rules will be deleted.`
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={busy === "delete" ? "loading" : "idle"}
        onConfirm={() => void remove()}
        onCancel={() => {
          if (!busy) {
            setDeleteOpen(false);
            setDeleteTargetId(null);
          }
        }}
      />
      <Modal
        open={importOpen}
        onClose={() => {
          if (busy !== "import") {
            setImportOpen(false);
            setImportError(null);
            setImportTargetId(null);
          }
        }}
        size="sm"
        breadcrumbs={[
          "Playbooks",
          importTargetId ? "Replace from Word" : "Import Word playbook",
        ]}
        footerStatus={
          busy === "import" ? (
            <span className="text-xs text-gray-500">
              Long files can take several minutes
            </span>
          ) : null
        }
        primaryAction={{
          label:
            busy === "import"
              ? "Compiling…"
              : importTargetId
                ? "Replace and compile"
                : "Import and compile",
          icon:
            busy === "import" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            ),
          variant: "blue",
          disabled: !importFile || !model || !!busy,
          onClick: () => void doImport(),
        }}
        cancelAction={{
          label: "Cancel",
          onClick: () => {
            setImportOpen(false);
            setImportError(null);
            setImportTargetId(null);
          },
          disabled: busy === "import",
        }}
      >
        <div
          data-modal-scroll="vertical"
          className="space-y-4 overflow-y-auto pb-4"
        >
          <p className="text-sm text-gray-600">
            {importTargetId
              ? "The imported concepts, positions, and sample clauses replace the current rules. Completed reviews keep the rules they used."
              : "Import concepts, positions, and sample clauses, then refine the rules in the editor. Changes save automatically."}
          </p>
          {busy === "import" && (
            <div
              role="status"
              className="flex items-start gap-2 text-sm text-gray-600"
            >
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>
                Compiling your playbook. Keep this window open until the rules
                are ready.
              </span>
            </div>
          )}
          {importError && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-red-600"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{importError}</span>
            </div>
          )}
          {!importTargetId && (
            <div>
              <ModalFieldLabel htmlFor="playbook-import-name">
                Playbook name (optional)
              </ModalFieldLabel>
              <ModalTextInput
                id="playbook-import-name"
                value={importName}
                onChange={(event) => setImportName(event.target.value)}
              />
            </div>
          )}
          <div>
            <ModalFieldLabel htmlFor="playbook-import-file">
              Word playbook
            </ModalFieldLabel>
            <input
              id="playbook-import-file"
              type="file"
              accept=".docx"
              onChange={(event) => {
                setImportFile(event.target.files?.[0] ?? null);
                setImportError(null);
              }}
              className="block w-full text-sm"
            />
          </div>
          <div>
            <ModalFieldLabel htmlFor="playbook-import-model">
              Compilation model
            </ModalFieldLabel>
            {models.length > 0 ? (
              <ModalSelect
                id="playbook-import-model"
                value={model}
                onChange={(value) => {
                  setModel(value);
                  setImportError(null);
                }}
                options={models}
                menuClassName="max-h-64"
              />
            ) : (
              <p className="text-sm text-amber-700">
                No compilation model is available.{" "}
                <a href="/account/api-keys" className="underline">
                  Configure an API key
                </a>{" "}
                or enable a local model.
              </p>
            )}
          </div>
        </div>
      </Modal>
      <Modal
        open={reviewOpen}
        onClose={() => {
          if (busy !== "review") {
            setReviewOpen(false);
            setReviewError(null);
          }
        }}
        size="lg"
        className="h-[min(720px,calc(100dvh-2rem))] [&_footer]:flex-wrap [&_footer>div:last-child]:ml-auto [&_footer_button]:whitespace-nowrap"
        breadcrumbs={["Playbooks", "Run playbook"]}
        footerLeading={
          <Dropdown>
            <DropdownTrigger asChild>
              <PillButton tone="white" size="normal" disabled={!!busy}>
                <Plus className="h-4 w-4" />
                Add document
              </PillButton>
            </DropdownTrigger>
            <DropdownContent
              side="top"
              align="start"
              onCloseAutoFocus={(event) => {
                if (openingDocumentPicker.current) event.preventDefault();
                openingDocumentPicker.current = false;
              }}
            >
              <DropdownItem
                onSelect={() => {
                  openingDocumentPicker.current = true;
                  reviewFileRef.current?.click();
                }}
              >
                <Upload className="h-4 w-4" />
                Upload documents
              </DropdownItem>
              <DropdownItem
                onSelect={() => {
                  openingDocumentPicker.current = true;
                  setSavedFilesOpen(true);
                }}
              >
                <Cloud className="h-4 w-4" />
                Saved files
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
        }
        primaryAction={{
          label:
            busy === "review"
              ? "Reviewing…"
              : pendingReviewDocuments.length > 0 &&
                  pendingReviewDocuments.every(
                    (item) => item.status === "failed",
                  )
                ? "Retry failed documents"
                : pendingReviewDocuments.length > 1
                  ? `Start ${pendingReviewDocuments.length} reviews`
                  : "Start review",
          icon:
            busy === "review" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            ),
          variant: "blue",
          disabled: !pendingReviewDocuments.length || !model || !!busy,
          onClick: () => void review(),
        }}
        cancelAction={{
          label: "Cancel",
          onClick: () => {
            setReviewOpen(false);
            setReviewError(null);
          },
          disabled: busy === "review",
        }}
      >
        <div
          data-modal-scroll="vertical"
          className="space-y-4 overflow-y-auto pb-4"
        >
          {reviewError && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-red-600"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{reviewError}</span>
            </div>
          )}
          <input
            ref={reviewFileRef}
            id="playbook-review-file"
            aria-label="Upload review document"
            type="file"
            accept=".pdf,.docx,.txt"
            multiple
            disabled={!!busy}
            className="hidden"
            onChange={(event) => {
              addReviewFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <PlaybookReviewDocuments
            documents={reviewDocuments}
            disabled={!!busy}
            onAdd={addReviewFiles}
            onBrowse={() => reviewFileRef.current?.click()}
            onRemove={(id) =>
              setReviewDocuments((items) =>
                items.filter((item) => item.id !== id),
              )
            }
          />
          <p className="text-xs text-gray-500">
            Uploaded files are saved to Library Files. Word documents get the
            recommended changes as tracked changes you can accept or reject.
          </p>
          <div>
            <ModalFieldLabel htmlFor="playbook-review-instructions">
              Review instructions
            </ModalFieldLabel>
            <ModalTextarea
              id="playbook-review-instructions"
              disabled={!!busy}
              value={reviewInstructions}
              onChange={(event) => setReviewInstructions(event.target.value)}
              rows={4}
            />
            <div
              className="mt-2 flex flex-wrap gap-2"
              aria-label="Suggested review prompts"
            >
              {[
                "Run a complete playbook review. Prioritize unacceptable and missing-required terms, quote exact contract language, and provide complete replacement language for issues that need revision.",
                "Show only unacceptable and missing-required terms.",
                "Explain the highest-risk deviations and propose redlines.",
              ].map((suggestion) => (
                <PillButton
                  key={suggestion}
                  tone="white"
                  size="xs"
                  disabled={!!busy}
                  onClick={() => setReviewInstructions(suggestion)}
                >
                  {suggestion.startsWith("Run a complete")
                    ? "Complete review"
                    : suggestion.startsWith("Show only")
                      ? "Unacceptable and missing terms"
                      : "Highest-risk deviations"}
                </PillButton>
              ))}
            </div>
          </div>
          <div>
            <ModalFieldLabel htmlFor="playbook-review-model">
              Review model
            </ModalFieldLabel>
            {models.length > 0 ? (
              <ModalSelect
                id="playbook-review-model"
                disabled={!!busy}
                value={model}
                onChange={(value) => {
                  setModel(value);
                  setReviewError(null);
                }}
                options={models}
                menuClassName="max-h-64"
              />
            ) : (
              <p className="text-sm text-amber-700">
                No review model is available.{" "}
                <a href="/account/api-keys" className="underline">
                  Configure an API key
                </a>{" "}
                or enable a local model.
              </p>
            )}
          </div>
          <div>
            <ModalFieldLabel htmlFor="playbook-review-mode">
              Review posture
            </ModalFieldLabel>
            <ModalSelect
              id="playbook-review-mode"
              disabled={!!busy}
              value={reviewMode}
              onChange={(value) =>
                setReviewMode(value as "strict" | "permissive")
              }
              options={[
                { value: "strict", label: "Strict — push standard positions" },
                { value: "permissive", label: "Permissive — allow fallbacks" },
              ]}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function NewPlaybookMenu({
  disabled,
  onImport,
  onBlank,
}: {
  disabled: boolean;
  onImport: () => void;
  onBlank: () => void;
}) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <HeaderButtonUI
          iconOnly
          disabled={disabled}
          title="New playbook"
          aria-label="New playbook"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </HeaderButtonUI>
      </DropdownTrigger>
      <DropdownContent align="end" className="w-64">
        <DropdownItem onSelect={onImport}>
          <Upload className="h-4 w-4" />
          <span className="flex flex-col">
            <span>Import Word playbook</span>
            <span className="text-xs text-gray-500">
              Compile a .docx into rules
            </span>
          </span>
        </DropdownItem>
        <DropdownItem onSelect={onBlank}>
          <FilePlus2 className="h-4 w-4" />
          <span className="flex flex-col">
            <span>Start from scratch</span>
            <span className="text-xs text-gray-500">
              Write the rules yourself
            </span>
          </span>
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
