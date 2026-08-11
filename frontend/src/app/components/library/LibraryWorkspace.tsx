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
    loadLibrary: (
        kind: LibraryKind,
        options?: { showLoading?: boolean },
    ) => Promise<void>;
    loadFolderChildren: (kind: LibraryKind, folderId: string) => Promise<void>;
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
    const folderChildrenRequestsRef = useRef<Map<string, Promise<void>>>(
        new Map(),
    );

    // Refetches root-level content plus every folder level already lazy-loaded
    // for this kind, so a refresh (e.g. after uploading a new document
    // version) doesn't drop the contents of folders the user has expanded.
    const loadLibrary = useCallback(
        async (kind: LibraryKind, options: { showLoading?: boolean } = {}) => {
            if (options.showLoading) {
                setLoadingByKind((prev) => ({ ...prev, [kind]: true }));
            }
            try {
                const loadedFolderIds = [...loadedFolderIdsByKind[kind]];
                const [root, childResults] = await Promise.all([
                    getLibrary(kind),
                    Promise.allSettled(
                        loadedFolderIds.map((folderId) =>
                            getLibraryFolderChildren(kind, folderId),
                        ),
                    ),
                ]);

                const documents = [...root.documents];
                const folders = [...root.folders];
                const seenDocIds = new Set(documents.map((d) => d.id));
                const seenFolderIds = new Set(folders.map((f) => f.id));
                const stillLoaded = new Set<string>();

                childResults.forEach((settled, index) => {
                    if (settled.status !== "fulfilled") return;
                    stillLoaded.add(loadedFolderIds[index]);
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
            } finally {
                if (options.showLoading) {
                    setLoadingByKind((prev) => ({ ...prev, [kind]: false }));
                }
            }
        },
        [loadedFolderIdsByKind],
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
            loadLibrary,
            loadFolderChildren,
            setSearchForKind,
            setDocumentsForKind,
            setFoldersForKind,
        }),
        [
            collections,
            loadingByKind,
            loadedFolderIdsByKind,
            loadLibrary,
            loadFolderChildren,
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
        loadLibrary,
        loadFolderChildren,
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
