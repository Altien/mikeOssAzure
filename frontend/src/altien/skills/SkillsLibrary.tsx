"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { getProject, listProjects } from "@/app/lib/mikeApi";
import type { Document, Project } from "@/app/components/shared/types";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    adaptSkillName,
    analyseSkillVersion,
    approveCleanRoomDeveloperArtifact,
    checkGitHubSkillUpdate,
    createCleanRoomDeveloperArtifact,
    deleteSkillVersion,
    downloadSkillPackage,
    downloadCleanRoomDeveloperArtifact,
    disableSkill,
    getGitHubSkillImportPolicy,
    getSkillPackageInfo,
    getSkillReview,
    importSkillZip,
    importSkillFromGitHub,
    listSkills,
    postSkillReviewMessage,
    runSkillVersion,
    setProjectSkillPin,
    type SkillListItem,
    type SkillPackageInfo,
    type SkillPendingAction,
    type GitHubSkillImportPolicy,
} from "./api";
import { messageFrom, useBusyAction } from "./useBusyAction";
import { ImportPanel } from "./ImportPanel";
import { formatSnapshotResult, ReviewPanel } from "./ReviewPanel";
import { AdaptationPanel, type DraftArtifact } from "./AdaptationPanel";
import { RunAndPinPanel } from "./RunAndPinPanel";
import { PackagesPanel, type SkillPackageKind } from "./PackagesPanel";
import { DeleteDraftPanel } from "./DeleteDraftPanel";

/** Triggers a browser download for an in-memory blob. */
function downloadBlob(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
}

export function SkillsLibrary() {
    const router = useRouter();
    const [skills, setSkills] = useState<SkillListItem[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectByVersion, setProjectByVersion] = useState<Record<string, string>>({});
    const [documentsByProject, setDocumentsByProject] = useState<
        Record<string, Document[]>
    >({});
    const [documentsByVersion, setDocumentsByVersion] = useState<
        Record<string, string[]>
    >({});
    const [pendingActionByVersion, setPendingActionByVersion] = useState<
        Record<string, SkillPendingAction | undefined>
    >({});
    const [amendByVersion, setAmendByVersion] = useState<Record<string, string>>({});
    const [snapshotByVersion, setSnapshotByVersion] = useState<Record<string, string>>({});
    const [snapshotOutputByVersion, setSnapshotOutputByVersion] = useState<
        Record<string, string | undefined>
    >({});
    const [packageInfo, setPackageInfo] = useState<Record<string, SkillPackageInfo>>({});
    const [githubPolicy, setGithubPolicy] =
        useState<GitHubSkillImportPolicy | null>(null);
    const [githubUrl, setGithubUrl] = useState("");
    const [renameByVersion, setRenameByVersion] = useState<Record<string, string>>({});
    const [developerRequirementByVersion, setDeveloperRequirementByVersion] =
        useState<Record<string, string>>({});
    const [updateByVersion, setUpdateByVersion] = useState<
        Record<string, string>
    >({});
    const [draftArtifactByVersion, setDraftArtifactByVersion] = useState<
        Record<string, DraftArtifact | undefined>
    >({});
    /** The draft awaiting an explicit delete confirmation, if any. */
    const [pendingDelete, setPendingDelete] = useState<SkillListItem | null>(
        null,
    );
    const fileInput = useRef<HTMLInputElement>(null);

    const [busyVersion, runForVersion] = useBusyAction<string>(setError);
    const [importKey, runImport] = useBusyAction<"import">(setError);
    const importing = importKey !== null;

    const refresh = useCallback(async () => {
        setError(null);
        try {
            const result = await listSkills();
            setSkills(result.skills);
            setCanManage(result.canManage);
            // Pending actions outlive the page: rehydrate them so a reload
            // still shows exactly what is awaiting approval.
            if (result.canManage) {
                const reviewable = result.skills.filter(
                    (skill) =>
                        skill.version.state === "draft" &&
                        skill.version.analysisState === "succeeded",
                );
                const reviews = await Promise.all(
                    reviewable.map((skill) =>
                        getSkillReview(skill.version.id)
                            .then((review) => [skill.version.id, review] as const)
                            .catch(() => null),
                    ),
                );
                setPendingActionByVersion((current) => {
                    const next = { ...current };
                    for (const entry of reviews) {
                        if (!entry) continue;
                        const [versionId, review] = entry;
                        const row = review?.pendingActions?.[0];
                        next[versionId] = row
                            ? {
                                  id: row.id,
                                  actionType: row.action_type,
                                  payload: row.payload,
                                  payloadHash: row.payload_hash,
                              }
                            : undefined;
                    }
                    return next;
                });
            }
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        void listProjects().then(setProjects).catch(() => setProjects([]));
        void getGitHubSkillImportPolicy()
            .then(setGithubPolicy)
            .catch(() => setGithubPolicy(null));
    }, [refresh]);

    const importFile = (file: File) =>
        void runImport(
            "import",
            async () => {
                await importSkillZip(file);
                await refresh();
            },
            {
                onSettled: () => {
                    if (fileInput.current) fileInput.current.value = "";
                },
            },
        );

    const setPendingAction = (
        versionId: string,
        action: SkillPendingAction | undefined,
    ) =>
        setPendingActionByVersion((current) => ({
            ...current,
            [versionId]: action,
        }));

    const analyse = (versionId: string) =>
        void runForVersion(versionId, async () => {
            await analyseSkillVersion(versionId);
            // The server refuses a pending action reviewed against the old
            // findings, so drop it here rather than showing a dead one.
            setPendingAction(versionId, undefined);
            await refresh();
        });

    const proposeEnable = (versionId: string) =>
        void runForVersion(versionId, async () => {
            const result = await postSkillReviewMessage(versionId, "enable");
            setPendingAction(versionId, result.action);
        });

    /** Approves whichever exact action is pending: enable, rename, or acquire. */
    const confirmPending = (versionId: string) =>
        void runForVersion(versionId, async () => {
            await postSkillReviewMessage(versionId, "yes");
            setPendingAction(versionId, undefined);
            await refresh();
        });

    const rejectPending = (versionId: string) =>
        void runForVersion(versionId, async () => {
            await postSkillReviewMessage(versionId, "no");
            setPendingAction(versionId, undefined);
        });

    /**
     * An amendment supersedes the reviewed action with a new one carrying a
     * new payload hash, so the panel always shows what will actually happen.
     */
    const amendPending = (versionId: string) => {
        const command = amendByVersion[versionId]?.trim();
        if (!command) return;
        void runForVersion(versionId, async () => {
            const result = await postSkillReviewMessage(versionId, command);
            setPendingAction(versionId, result.action);
            setAmendByVersion((current) => ({ ...current, [versionId]: "" }));
        });
    };

    const runSnapshotCommand = (versionId: string) => {
        const command = snapshotByVersion[versionId]?.trim();
        if (!command) return;
        void runForVersion(versionId, async () => {
            const result = await postSkillReviewMessage(versionId, command);
            setSnapshotOutputByVersion((current) => ({
                ...current,
                [versionId]: result.result
                    ? formatSnapshotResult(result.result)
                    : "No snapshot result.",
            }));
        });
    };

    /** Picking a run project resets the doc selection and lazily loads its documents. */
    const selectRunProject = (versionId: string, projectId: string) => {
        setProjectByVersion((current) => ({
            ...current,
            [versionId]: projectId,
        }));
        setDocumentsByVersion((current) => ({ ...current, [versionId]: [] }));
        if (projectId && !documentsByProject[projectId]) {
            void getProject(projectId)
                .then((project) =>
                    setDocumentsByProject((current) => ({
                        ...current,
                        [projectId]: project.documents ?? [],
                    })),
                )
                .catch(() =>
                    setDocumentsByProject((current) => ({
                        ...current,
                        [projectId]: [],
                    })),
                );
        }
    };

    const run = (skill: SkillListItem) => {
        const projectId = projectByVersion[skill.version.id];
        if (!projectId) {
            setError("Select a project before running a skill.");
            return;
        }
        void runForVersion(
            skill.version.id,
            async () => {
                const result = await runSkillVersion(
                    skill.version.id,
                    projectId,
                    documentsByVersion[skill.version.id] ?? [],
                );
                router.push(
                    `/projects/${encodeURIComponent(projectId)}/assistant/chat/${encodeURIComponent(result.chatId)}`,
                );
            },
            { keepBusyOnSuccess: true },
        );
    };

    const pin = (skill: SkillListItem) => {
        const projectId = projectByVersion[skill.version.id];
        if (!projectId) {
            setError("Select a project before pinning a skill version.");
            return;
        }
        void runForVersion(skill.version.id, async () => {
            await setProjectSkillPin(projectId, skill.id, skill.version.id);
        });
    };

    const disable = (skill: SkillListItem) =>
        void runForVersion(skill.version.id, async () => {
            await disableSkill(skill.id);
            await refresh();
        });

    /**
     * Deletes the confirmed draft. The popup closes either way: a refusal
     * (pinned, bound to a chat, no longer a draft) is reported in the page
     * error banner rather than under the confirmation.
     */
    const confirmDelete = () => {
        const target = pendingDelete;
        if (!target) return;
        void runForVersion(
            target.version.id,
            async () => {
                await deleteSkillVersion(target.version.id);
                await refresh();
            },
            { onSettled: () => setPendingDelete(null) },
        );
    };

    const showPackages = (versionId: string) =>
        runForVersion(versionId, async () => {
            const info = await getSkillPackageInfo(versionId);
            setPackageInfo((current) => ({ ...current, [versionId]: info }));
        });

    const downloadPackage = (versionId: string, kind: SkillPackageKind) =>
        void runForVersion(versionId, async () => {
            const result = await downloadSkillPackage(versionId, kind);
            downloadBlob(result.filename, result.blob);
        });

    const rename = (skill: SkillListItem) => {
        const newDisplayName = renameByVersion[skill.version.id]?.trim();
        if (!newDisplayName) return;
        void runForVersion(skill.version.id, async () => {
            await adaptSkillName(skill.version.id, newDisplayName);
            setRenameByVersion((current) => ({
                ...current,
                [skill.version.id]: "",
            }));
            await refresh();
        });
    };

    const createDeveloperArtifact = (skill: SkillListItem) => {
        const requirement =
            developerRequirementByVersion[skill.version.id]?.trim();
        if (!requirement) return;
        void runForVersion(skill.version.id, async () => {
            const artifact = await createCleanRoomDeveloperArtifact(
                skill.version.id,
                requirement,
            );
            setDraftArtifactByVersion((current) => ({
                ...current,
                [skill.version.id]: {
                    id: artifact.id,
                    filename: artifact.filename,
                    reviewPayloadHash: artifact.reviewPayloadHash,
                },
            }));
            setDeveloperRequirementByVersion((current) => ({
                ...current,
                [skill.version.id]: "",
            }));
            await showPackages(skill.version.id);
        });
    };

    const reviewArtifact = (versionId: string, artifact: DraftArtifact) =>
        void runForVersion(versionId, async () => {
            const result = await downloadCleanRoomDeveloperArtifact(
                artifact.id,
            );
            downloadBlob(result.filename, result.blob);
        });

    const approveArtifact = (versionId: string, artifact: DraftArtifact) =>
        void runForVersion(versionId, async () => {
            await approveCleanRoomDeveloperArtifact(
                artifact.id,
                artifact.reviewPayloadHash,
            );
            setDraftArtifactByVersion((current) => ({
                ...current,
                [versionId]: undefined,
            }));
            await showPackages(versionId);
        });

    const checkUpdate = (skill: SkillListItem) =>
        void runForVersion(skill.version.id, async () => {
            const result = await checkGitHubSkillUpdate(skill.version.id);
            setUpdateByVersion((current) => ({
                ...current,
                [skill.version.id]: result.updateAvailable
                    ? `Update available at ${result.currentCommitSha.slice(0, 12)}. Import the GitHub URL to create a new draft version.`
                    : "Tracked GitHub ref is unchanged.",
            }));
        });

    const importGitHub = () => {
        if (!githubUrl.trim()) return;
        void runImport("import", async () => {
            await importSkillFromGitHub(githubUrl.trim());
            setGithubUrl("");
            await refresh();
        });
    };

    return (
        // The app shell is md:overflow-hidden, so a page taller than the
        // viewport is clipped unless it scrolls itself. Skill cards grow with
        // their analysis, and the controls sit at the bottom of the card.
        <div className="h-full w-full overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-8">
            <ImportPanel
                canManage={canManage}
                importing={importing}
                fileInput={fileInput}
                onImportFile={importFile}
                githubPolicy={githubPolicy}
                githubUrl={githubUrl}
                onGithubUrlChange={setGithubUrl}
                onImportGitHub={importGitHub}
            />

            {error && (
                <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                    {error}
                </div>
            )}

            {loading ? (
                <p className="mt-10 text-sm text-slate-500">Loading skills…</p>
            ) : skills.length === 0 ? (
                <div className="mt-10 rounded-xl border border-dashed border-slate-300 p-10 text-center">
                    <PackageOpen className="mx-auto h-8 w-8 text-slate-400" />
                    <p className="mt-3 text-sm font-medium text-slate-800">
                        No skills are available yet
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                        {canManage
                            ? "Import an Agent Skills ZIP to create a draft."
                            : "A TenantAdmin can import and enable skills."}
                    </p>
                </div>
            ) : (
                <ul className="mt-8 grid gap-4 md:grid-cols-2">
                    {skills.map((skill) => (
                        <li key={skill.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                                <h2 className="font-medium text-slate-950">
                                    {skill.displayName}
                                </h2>
                                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs capitalize text-slate-600">
                                    {skill.isUpdate
                                        ? "update draft"
                                        : skill.version.state}
                                </span>
                            </div>
                            <p className="mt-2 text-sm text-slate-600">
                                {skill.description}
                            </p>
                            <p className="mt-4 truncate font-mono text-xs text-slate-500">
                                {skill.version.entrypointPath}
                            </p>
                            {canManage && (
                                <div className="mt-4 border-t border-slate-100 pt-4">
                                    <ReviewPanel
                                        skill={skill}
                                        busy={busyVersion === skill.version.id}
                                        pendingAction={
                                            pendingActionByVersion[
                                                skill.version.id
                                            ]
                                        }
                                        amendValue={
                                            amendByVersion[skill.version.id] ??
                                            ""
                                        }
                                        onAmendChange={(value) =>
                                            setAmendByVersion((current) => ({
                                                ...current,
                                                [skill.version.id]: value,
                                            }))
                                        }
                                        onAmend={amendPending}
                                        snapshotValue={
                                            snapshotByVersion[
                                                skill.version.id
                                            ] ?? ""
                                        }
                                        onSnapshotChange={(value) =>
                                            setSnapshotByVersion((current) => ({
                                                ...current,
                                                [skill.version.id]: value,
                                            }))
                                        }
                                        onSnapshotCommand={runSnapshotCommand}
                                        snapshotOutput={
                                            snapshotOutputByVersion[
                                                skill.version.id
                                            ]
                                        }
                                        onAnalyse={analyse}
                                        onProposeEnable={proposeEnable}
                                        onConfirmPending={confirmPending}
                                        onRejectPending={rejectPending}
                                    />
                                    <AdaptationPanel
                                        skill={skill}
                                        busy={busyVersion === skill.version.id}
                                        renameValue={
                                            renameByVersion[skill.version.id] ??
                                            ""
                                        }
                                        onRenameChange={(value) =>
                                            setRenameByVersion((current) => ({
                                                ...current,
                                                [skill.version.id]: value,
                                            }))
                                        }
                                        onRename={rename}
                                        requirementValue={
                                            developerRequirementByVersion[
                                                skill.version.id
                                            ] ?? ""
                                        }
                                        onRequirementChange={(value) =>
                                            setDeveloperRequirementByVersion(
                                                (current) => ({
                                                    ...current,
                                                    [skill.version.id]: value,
                                                }),
                                            )
                                        }
                                        onCreateDeveloperArtifact={
                                            createDeveloperArtifact
                                        }
                                        updateMessage={
                                            updateByVersion[skill.version.id]
                                        }
                                        onCheckUpdate={checkUpdate}
                                        draftArtifact={
                                            draftArtifactByVersion[
                                                skill.version.id
                                            ]
                                        }
                                        onReviewArtifact={reviewArtifact}
                                        onApproveArtifact={approveArtifact}
                                    />
                                    <DeleteDraftPanel
                                        skill={skill}
                                        busy={busyVersion === skill.version.id}
                                        onRequestDelete={setPendingDelete}
                                    />
                                </div>
                            )}
                            {skill.version.state === "enabled" && (
                                <RunAndPinPanel
                                    skill={skill}
                                    busy={busyVersion === skill.version.id}
                                    canManage={canManage}
                                    projects={projects}
                                    selectedProjectId={
                                        projectByVersion[skill.version.id] ?? ""
                                    }
                                    projectDocuments={
                                        documentsByProject[
                                            projectByVersion[
                                                skill.version.id
                                            ] ?? ""
                                        ] ?? []
                                    }
                                    selectedDocumentIds={
                                        documentsByVersion[skill.version.id] ??
                                        []
                                    }
                                    onDocumentsChange={(documentIds) =>
                                        setDocumentsByVersion((current) => ({
                                            ...current,
                                            [skill.version.id]: documentIds,
                                        }))
                                    }
                                    onProjectChange={(projectId) =>
                                        selectRunProject(
                                            skill.version.id,
                                            projectId,
                                        )
                                    }
                                    onRun={run}
                                    onPin={pin}
                                    onDisable={disable}
                                />
                            )}
                            <PackagesPanel
                                skill={skill}
                                busy={busyVersion === skill.version.id}
                                packageInfo={packageInfo[skill.version.id]}
                                onShowPackages={(versionId) =>
                                    void showPackages(versionId)
                                }
                                onDownloadPackage={downloadPackage}
                            />
                        </li>
                    ))}
                </ul>
            )}

            <ConfirmPopup
                open={!!pendingDelete}
                title="Delete this draft skill?"
                message={
                    pendingDelete
                        ? `“${pendingDelete.displayName}” and its imported snapshot are removed permanently. This cannot be undone.`
                        : undefined
                }
                confirmLabel="Delete"
                confirmStatus={
                    pendingDelete && busyVersion === pendingDelete.version.id
                        ? "loading"
                        : "idle"
                }
                onCancel={() => setPendingDelete(null)}
                onConfirm={confirmDelete}
            />
        </div>
        </div>
    );
}
