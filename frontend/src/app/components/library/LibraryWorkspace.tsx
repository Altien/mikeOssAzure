"use client";

import {
    createContext,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { Plus, Upload } from "lucide-react";
import { DocTable } from "@/app/components/documents/DocTable";
import type { DocTableFolder } from "@/app/components/documents/DocTable";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
    createLibraryFolder,
    deleteLibraryFolder,
    getLibrary,
    getLibraryFolderChildren,
    moveLibraryDocument,
    moveLibraryFolder,
    renameLibraryDocument,
    renameLibraryFolder,
    uploadLibraryDocument,
    type LibraryKind,
} from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";

type LibraryViewCollection = {
    documents: Document[];
    folders: DocTableFolder[];
};

type LibraryWorkspaceContextValue = {
    collections: Record<LibraryKind, LibraryViewCollection | null>;
    loadingByKind: Record<LibraryKind, boolean>;
    searchByKind: Record<LibraryKind, string>;
    loadedFolderIdsByKind: Record<LibraryKind, Set<string>>;
    documentsHasMoreByKind: Record<LibraryKind, Record<string, boolean>>;
    loadingMoreDocumentsByKind: Record<LibraryKind, Record<string, boolean>>;
    loadLibrary: (
        kind: LibraryKind,
        options?: { showLoading?: boolean },
    ) => Promise<void>;
    loadFolderChildren: (kind: LibraryKind, folderId: string) => Promise<void>;
    loadMoreDocuments: (
        kind: LibraryKind,
        parentId: string | null,
    ) => Promise<void>;
    setSearchForKind: (kind: LibraryKind, value: string) => void;
    setDocumentsForKind: (
        kind: LibraryKind,
        update: SetStateAction<Document[]>,
    ) => void;
    setFoldersForKind: (
        kind: LibraryKind,
        update: SetStateAction<DocTableFolder[]>,
    ) => void;
};

const LIBRARY_TABS: { id: LibraryKind; label: string }[] = [
    { id: "files", label: "Files" },
    { id: "templates", label: "Templates" },
];

const EMPTY_COLLECTION: LibraryViewCollection = {
    documents: [],
    folders: [],
};

// Sentinel key identifying the root level in the per-level pagination maps
// below (folder levels are keyed by their real folder id, which is always a
// uuid and so can never collide with this).
const ROOT_LEVEL_KEY = "root";
const DOCUMENT_PAGE_SIZE = 50;

function libraryLevelKey(parentId: string | null): string {
    return parentId ?? ROOT_LEVEL_KEY;
}

const LibraryWorkspaceContext =
    createContext<LibraryWorkspaceContextValue | null>(null);

function useLibraryWorkspace() {
    const context = useContext(LibraryWorkspaceContext);
    if (!context) {
        throw new Error(
            "useLibraryWorkspace must be used inside LibraryWorkspaceProvider",
        );
    }
    return context;
}

export function LibraryWorkspaceProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [collections, setCollections] = useState<
        Record<LibraryKind, LibraryViewCollection | null>
    >({
        files: null,
        templates: null,
    });
    const [loadingByKind, setLoadingByKind] = useState<
        Record<LibraryKind, boolean>
    >({
        files: false,
        templates: false,
    });
    const [searchByKind, setSearchByKind] = useState<
        Record<LibraryKind, string>
    >({
        files: "",
        templates: "",
    });
    const [loadedFolderIdsByKind, setLoadedFolderIdsByKind] = useState<
        Record<LibraryKind, Set<string>>
    >({
        files: new Set(),
        templates: new Set(),
    });
    // Per-level (root or folder id) document paging state: how many
    // documents are currently requested for that level, whether the server
    // has more beyond that, and whether a "load more" fetch is in flight.
    const [documentLimitByKind, setDocumentLimitByKind] = useState<
        Record<LibraryKind, Record<string, number>>
    >({ files: {}, templates: {} });
    const [documentsHasMoreByKind, setDocumentsHasMoreByKind] = useState<
        Record<LibraryKind, Record<string, boolean>>
    >({ files: {}, templates: {} });
    const [loadingMoreDocumentsByKind, setLoadingMoreDocumentsByKind] =
        useState<Record<LibraryKind, Record<string, boolean>>>({
            files: {},
            templates: {},
        });
    const folderChildrenRequestsRef = useRef<Map<string, Promise<void>>>(
        new Map(),
    );
    const loadMoreDocumentsRequestsRef = useRef<Map<string, Promise<void>>>(
        new Map(),
    );

    // Refetches root-level content plus every folder level already lazy-loaded
    // for this kind (each level re-requested at its current page size), so a
    // refresh (e.g. after uploading a new document version) doesn't drop the
    // contents of folders the user has expanded, or documents loaded beyond
    // the first page.
    const loadLibrary = useCallback(
        async (kind: LibraryKind, options: { showLoading?: boolean } = {}) => {
            if (options.showLoading) {
                setLoadingByKind((prev) => ({ ...prev, [kind]: true }));
            }
            try {
                const loadedFolderIds = [...loadedFolderIdsByKind[kind]];
                const limits = documentLimitByKind[kind];
                const [root, childResults] = await Promise.all([
                    getLibrary(kind, {
                        limit: limits[ROOT_LEVEL_KEY] ?? DOCUMENT_PAGE_SIZE,
                    }),
                    Promise.allSettled(
                        loadedFolderIds.map((folderId) =>
                            getLibraryFolderChildren(kind, folderId, {
                                limit: limits[folderId] ?? DOCUMENT_PAGE_SIZE,
                            }),
                        ),
                    ),
                ]);

                const documents = [...root.documents];
                const folders = [...root.folders];
                const seenDocIds = new Set(documents.map((d) => d.id));
                const seenFolderIds = new Set(folders.map((f) => f.id));
                const stillLoaded = new Set<string>();
                const nextHasMore: Record<string, boolean> = {
                    [ROOT_LEVEL_KEY]: root.documentsHasMore,
                };

                childResults.forEach((settled, index) => {
                    if (settled.status !== "fulfilled") return;
                    const folderId = loadedFolderIds[index];
                    stillLoaded.add(folderId);
                    nextHasMore[folderId] = settled.value.documentsHasMore;
                    for (const doc of settled.value.documents) {
                        if (seenDocIds.has(doc.id)) continue;
                        seenDocIds.add(doc.id);
                        documents.push(doc);
                    }
                    for (const folder of settled.value.folders) {
                        if (seenFolderIds.has(folder.id)) continue;
                        seenFolderIds.add(folder.id);
                        folders.push(folder);
                    }
                });

                setCollections((prev) => ({
                    ...prev,
                    [kind]: { documents, folders },
                }));
                setLoadedFolderIdsByKind((prev) => ({
                    ...prev,
                    [kind]: stillLoaded,
                }));
                setDocumentsHasMoreByKind((prev) => ({
                    ...prev,
                    [kind]: nextHasMore,
                }));
            } catch (error) {
                console.error("[library] failed to load", error);
                setCollections((prev) => ({
                    ...prev,
                    [kind]: EMPTY_COLLECTION,
                }));
                setLoadedFolderIdsByKind((prev) => ({
                    ...prev,
                    [kind]: new Set(),
                }));
                setDocumentLimitByKind((prev) => ({ ...prev, [kind]: {} }));
                setDocumentsHasMoreByKind((prev) => ({ ...prev, [kind]: {} }));
            } finally {
                if (options.showLoading) {
                    setLoadingByKind((prev) => ({ ...prev, [kind]: false }));
                }
            }
        },
        [loadedFolderIdsByKind, documentLimitByKind],
    );

    const loadFolderChildren = useCallback(
        async (kind: LibraryKind, folderId: string) => {
            if (loadedFolderIdsByKind[kind].has(folderId)) return;
            const key = `${kind}:${folderId}`;
            const inFlight = folderChildrenRequestsRef.current.get(key);
            if (inFlight) return inFlight;

            const request = (async () => {
                try {
                    const children = await getLibraryFolderChildren(
                        kind,
                        folderId,
                        { limit: DOCUMENT_PAGE_SIZE },
                    );
                    setCollections((prev) => {
                        const current = prev[kind] ?? EMPTY_COLLECTION;
                        const existingDocIds = new Set(
                            current.documents.map((d) => d.id),
                        );
                        const existingFolderIds = new Set(
                            current.folders.map((f) => f.id),
                        );
                        return {
                            ...prev,
                            [kind]: {
                                documents: [
                                    ...current.documents,
                                    ...children.documents.filter(
                                        (d) => !existingDocIds.has(d.id),
                                    ),
                                ],
                                folders: [
                                    ...current.folders,
                                    ...children.folders.filter(
                                        (f) => !existingFolderIds.has(f.id),
                                    ),
                                ],
                            },
                        };
                    });
                    setLoadedFolderIdsByKind((prev) => {
                        const next = new Set(prev[kind]);
                        next.add(folderId);
                        return { ...prev, [kind]: next };
                    });
                    setDocumentLimitByKind((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], [folderId]: DOCUMENT_PAGE_SIZE },
                    }));
                    setDocumentsHasMoreByKind((prev) => ({
                        ...prev,
                        [kind]: {
                            ...prev[kind],
                            [folderId]: children.documentsHasMore,
                        },
                    }));
                } catch (error) {
                    console.error(
                        "[library] failed to load folder children",
                        error,
                    );
                } finally {
                    folderChildrenRequestsRef.current.delete(key);
                }
            })();
            folderChildrenRequestsRef.current.set(key, request);
            return request;
        },
        [loadedFolderIdsByKind],
    );

    // Fetches the next page of documents for a single level (root or one
    // folder), replacing just that level's documents/folders in place —
    // everything belonging to other levels is left untouched.
    const loadMoreDocuments = useCallback(
        async (kind: LibraryKind, parentId: string | null) => {
            const levelKey = libraryLevelKey(parentId);
            const requestKey = `${kind}:${levelKey}`;
            const inFlight = loadMoreDocumentsRequestsRef.current.get(requestKey);
            if (inFlight) return inFlight;

            const nextLimit =
                (documentLimitByKind[kind][levelKey] ?? DOCUMENT_PAGE_SIZE) +
                DOCUMENT_PAGE_SIZE;
            setLoadingMoreDocumentsByKind((prev) => ({
                ...prev,
                [kind]: { ...prev[kind], [levelKey]: true },
            }));

            const request = (async () => {
                try {
                    const page =
                        parentId === null
                            ? await getLibrary(kind, { limit: nextLimit })
                            : await getLibraryFolderChildren(kind, parentId, {
                                  limit: nextLimit,
                              });

                    setCollections((prev) => {
                        const current = prev[kind] ?? EMPTY_COLLECTION;
                        const documents = [
                            ...current.documents.filter(
                                (d) => (d.folder_id ?? null) !== parentId,
                            ),
                            ...page.documents,
                        ];
                        const folders = [
                            ...current.folders.filter(
                                (f) =>
                                    (f.parent_folder_id ?? null) !== parentId,
                            ),
                            ...page.folders,
                        ];
                        return { ...prev, [kind]: { documents, folders } };
                    });
                    setDocumentLimitByKind((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], [levelKey]: nextLimit },
                    }));
                    setDocumentsHasMoreByKind((prev) => ({
                        ...prev,
                        [kind]: {
                            ...prev[kind],
                            [levelKey]: page.documentsHasMore,
                        },
                    }));
                } catch (error) {
                    console.error(
                        "[library] failed to load more documents",
                        error,
                    );
                } finally {
                    setLoadingMoreDocumentsByKind((prev) => ({
                        ...prev,
                        [kind]: { ...prev[kind], [levelKey]: false },
                    }));
                    loadMoreDocumentsRequestsRef.current.delete(requestKey);
                }
            })();
            loadMoreDocumentsRequestsRef.current.set(requestKey, request);
            return request;
        },
        [documentLimitByKind],
    );

    const setSearchForKind = useCallback((kind: LibraryKind, value: string) => {
        setSearchByKind((prev) => ({ ...prev, [kind]: value }));
    }, []);

    const setDocumentsForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<Document[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextDocuments =
                    typeof update === "function"
                        ? update(current.documents)
                        : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        documents: nextDocuments,
                    },
                };
            });
        },
        [],
    );

    const setFoldersForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<DocTableFolder[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextFolders =
                    typeof update === "function"
                        ? update(current.folders)
                        : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        folders: nextFolders,
                    },
                };
            });
        },
        [],
    );

    const value = useMemo(
        () => ({
            collections,
            loadingByKind,
            searchByKind,
            loadedFolderIdsByKind,
            documentsHasMoreByKind,
            loadingMoreDocumentsByKind,
            loadLibrary,
            loadFolderChildren,
            loadMoreDocuments,
            setSearchForKind,
            setDocumentsForKind,
            setFoldersForKind,
        }),
        [
            collections,
            loadingByKind,
            loadedFolderIdsByKind,
            documentsHasMoreByKind,
            loadingMoreDocumentsByKind,
            loadLibrary,
            loadFolderChildren,
            loadMoreDocuments,
            searchByKind,
            setDocumentsForKind,
            setFoldersForKind,
            setSearchForKind,
        ],
    );

    return (
        <LibraryWorkspaceContext.Provider value={value}>
            {children}
        </LibraryWorkspaceContext.Provider>
    );
}

export function LibraryWorkspaceLayout({ children }: { children: ReactNode }) {
    return <LibraryWorkspaceProvider>{children}</LibraryWorkspaceProvider>;
}

export function LibraryCollectionPage({ kind }: { kind: LibraryKind }) {
    const router = useRouter();
    const {
        collections,
        loadingByKind,
        searchByKind,
        documentsHasMoreByKind,
        loadingMoreDocumentsByKind,
        loadLibrary,
        loadFolderChildren,
        loadMoreDocuments,
        setSearchForKind,
        setDocumentsForKind,
        setFoldersForKind,
    } = useLibraryWorkspace();
    const collection = collections[kind];
    const search = searchByKind[kind];
    const title = kind === "files" ? "Files" : "Templates";

    useEffect(() => {
        if (collection) return;
        void loadLibrary(kind, { showLoading: true });
    }, [collection, kind, loadLibrary]);

    const setDocuments: Dispatch<SetStateAction<Document[]>> = useCallback(
        (update) => setDocumentsForKind(kind, update),
        [kind, setDocumentsForKind],
    );
    const setFolders: Dispatch<SetStateAction<DocTableFolder[]>> = useCallback(
        (update) => setFoldersForKind(kind, update),
        [kind, setFoldersForKind],
    );
    const [addDocumentsAction, setAddDocumentsAction] = useState<
        (() => void) | null
    >(null);
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const loading = !collection || loadingByKind[kind];
    const addCollectionLabel = kind === "templates" ? "Templates" : "Files";

    const handleAddDocumentsActionChange = useCallback(
        (action: (() => void) | null) => {
            setAddDocumentsAction(() => action);
        },
        [],
    );

    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );

    const handleExpandFolder = useCallback(
        (folderId: string) => loadFolderChildren(kind, folderId),
        [kind, loadFolderChildren],
    );

    const handleLoadMoreDocuments = useCallback(
        (parentId: string | null) => loadMoreDocuments(kind, parentId),
        [kind, loadMoreDocuments],
    );

    const operations = useMemo(
        () => ({
            uploadDocument: (file: File) => uploadLibraryDocument(kind, file),
            refreshCollection: () => loadLibrary(kind),
            createFolder: (name: string, parentFolderId?: string | null) =>
                createLibraryFolder(kind, name, parentFolderId),
            renameFolder: (folderId: string, name: string) =>
                renameLibraryFolder(kind, folderId, name),
            deleteFolder: (folderId: string) =>
                deleteLibraryFolder(kind, folderId),
            moveFolder: (folderId: string, parentFolderId: string | null) =>
                moveLibraryFolder(kind, folderId, parentFolderId),
            moveDocument: (documentId: string, folderId: string | null) =>
                moveLibraryDocument(kind, documentId, folderId),
            renameDocument: (documentId: string, filename: string) =>
                renameLibraryDocument(kind, documentId, filename),
        }),
        [kind, loadLibrary],
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[{ label: "Library" }, { label: title }]}
                actionGroups={[
                    {
                        actions: [
                            {
                                type: "search",
                                value: search,
                                onChange: (value) =>
                                    setSearchForKind(kind, value),
                                placeholder: `Search ${title.toLowerCase()}...`,
                            },
                        ],
                    },
                    {
                        actions: [
                            {
                                icon: <Upload className="h-3.5 w-3.5" />,
                                label: (
                                    <span className="hidden sm:inline">
                                        {addCollectionLabel}
                                    </span>
                                ),
                                title: `Add ${addCollectionLabel}`,
                                onClick: addDocumentsAction ?? undefined,
                                disabled: !addDocumentsAction || loading,
                            },
                        ],
                    },
                ]}
            />

            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={LIBRARY_TABS}
                    active={kind}
                    onChange={(next) =>
                        router.push(
                            next === "files" ? "/library" : "/library/templates",
                        )
                    }
                    actions={
                        <TabPillButton
                            onClick={createFolderAction ?? undefined}
                            disabled={!createFolderAction || loading}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Folder</span>
                        </TabPillButton>
                    }
                />
                <DocTable
                    scopeKey={kind}
                    documents={collection?.documents ?? []}
                    setDocuments={setDocuments}
                    folders={collection?.folders ?? []}
                    setFolders={setFolders}
                    loading={loading}
                    search={search}
                    operations={operations}
                    onAddDocumentsActionChange={handleAddDocumentsActionChange}
                    onCreateFolderActionChange={
                        handleCreateFolderActionChange
                    }
                    onExpandFolder={handleExpandFolder}
                    documentsHasMoreByLevel={documentsHasMoreByKind[kind]}
                    loadingMoreDocumentsByLevel={
                        loadingMoreDocumentsByKind[kind]
                    }
                    onLoadMoreDocuments={handleLoadMoreDocuments}
                    enableHeaderFilters
                    emptyDropLabel={
                        kind === "templates"
                            ? "Drop template files here"
                            : "Drop PDF, Word, Excel, or PowerPoint files here"
                    }
                />
            </div>
        </div>
    );
}
