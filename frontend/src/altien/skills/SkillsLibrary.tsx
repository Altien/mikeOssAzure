"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload, PackageOpen, Play, ScanSearch } from "lucide-react";
import { listProjects } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import {
    analyseSkillVersion,
    downloadSkillPackage,
    getGitHubSkillImportPolicy,
    getSkillPackageInfo,
    importSkillZip,
    importSkillFromGitHub,
    listSkills,
    postSkillReviewMessage,
    runSkillVersion,
    type SkillListItem,
    type SkillPackageInfo,
    type GitHubSkillImportPolicy,
} from "./api";

function messageFrom(error: unknown) {
    return error instanceof Error ? error.message : "The request failed.";
}

export function SkillsLibrary() {
    const router = useRouter();
    const [skills, setSkills] = useState<SkillListItem[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectByVersion, setProjectByVersion] = useState<Record<string, string>>({});
    const [pendingEnable, setPendingEnable] = useState<Record<string, boolean>>({});
    const [busyVersion, setBusyVersion] = useState<string | null>(null);
    const [packageInfo, setPackageInfo] = useState<Record<string, SkillPackageInfo>>({});
    const [githubPolicy, setGithubPolicy] =
        useState<GitHubSkillImportPolicy | null>(null);
    const [githubUrl, setGithubUrl] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async () => {
        setError(null);
        try {
            const result = await listSkills();
            setSkills(result.skills);
            setCanManage(result.canManage);
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

    async function importFile(file: File) {
        setImporting(true);
        setError(null);
        try {
            await importSkillZip(file);
            await refresh();
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setImporting(false);
            if (fileInput.current) fileInput.current.value = "";
        }
    }

    async function analyse(versionId: string) {
        setBusyVersion(versionId);
        setError(null);
        try {
            await analyseSkillVersion(versionId);
            await refresh();
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setBusyVersion(null);
        }
    }

    async function proposeEnable(versionId: string) {
        setBusyVersion(versionId);
        setError(null);
        try {
            const result = await postSkillReviewMessage(versionId, "enable");
            setPendingEnable((current) => ({ ...current, [versionId]: result.outcome === "proposed" }));
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setBusyVersion(null);
        }
    }

    async function confirmEnable(versionId: string) {
        setBusyVersion(versionId);
        setError(null);
        try {
            await postSkillReviewMessage(versionId, "yes");
            setPendingEnable((current) => ({ ...current, [versionId]: false }));
            await refresh();
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setBusyVersion(null);
        }
    }

    async function run(skill: SkillListItem) {
        const projectId = projectByVersion[skill.version.id];
        if (!projectId) {
            setError("Select a project before running a skill.");
            return;
        }
        setBusyVersion(skill.version.id);
        setError(null);
        try {
            const result = await runSkillVersion(skill.version.id, projectId);
            router.push(`/projects/${encodeURIComponent(projectId)}/assistant/chat/${encodeURIComponent(result.chatId)}`);
        } catch (caught) {
            setError(messageFrom(caught));
            setBusyVersion(null);
        }
    }

    async function showPackages(versionId: string) {
        setBusyVersion(versionId);
        setError(null);
        try {
            const info = await getSkillPackageInfo(versionId);
            setPackageInfo((current) => ({ ...current, [versionId]: info }));
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setBusyVersion(null);
        }
    }

    async function downloadPackage(versionId: string, kind: "original" | "mike") {
        setBusyVersion(versionId);
        setError(null);
        try {
            const result = await downloadSkillPackage(versionId, kind);
            const url = URL.createObjectURL(result.blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = result.filename;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setBusyVersion(null);
        }
    }

    async function importGitHub() {
        if (!githubUrl.trim()) return;
        setImporting(true);
        setError(null);
        try {
            await importSkillFromGitHub(githubUrl.trim());
            setGithubUrl("");
            await refresh();
        } catch (caught) {
            setError(messageFrom(caught));
        } finally {
            setImporting(false);
        }
    }

    return (
        <main className="mx-auto w-full max-w-6xl px-6 py-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="font-serif text-3xl text-slate-950">Skills</h1>
                    <p className="mt-2 max-w-2xl text-sm text-slate-600">
                        Reusable instruction packages available to project chats.
                    </p>
                </div>
                {canManage && (
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
                        <Upload className="h-4 w-4" />
                        {importing ? "Importing…" : "Import ZIP"}
                        <input
                            ref={fileInput}
                            className="sr-only"
                            type="file"
                            accept=".zip,application/zip"
                            disabled={importing}
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) void importFile(file);
                            }}
                        />
                    </label>
                )}
            </div>

            {canManage && githubPolicy?.effectiveEnabled && (
                <div className="mt-6 flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-4">
                    <input
                        value={githubUrl}
                        onChange={(event) => setGithubUrl(event.target.value)}
                        placeholder="https://github.com/owner/repository/tree/ref/path"
                        aria-label="GitHub skill URL"
                        className="min-w-72 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button
                        type="button"
                        disabled={importing || !githubUrl.trim()}
                        onClick={() => void importGitHub()}
                        className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
                    >
                        Import from GitHub
                    </button>
                </div>
            )}

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
                                    {skill.version.state}
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
                                    <p className="text-xs text-slate-500">
                                        Analysis: {skill.version.analysisState}
                                        {skill.version.analysisModel
                                            ? ` · ${skill.version.analysisModel}`
                                            : ""}
                                    </p>
                                    {skill.version.state === "draft" &&
                                        skill.version.analysisState !== "succeeded" && (
                                            <button
                                                type="button"
                                                disabled={busyVersion === skill.version.id}
                                                onClick={() => void analyse(skill.version.id)}
                                                className="mt-3 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                <ScanSearch className="h-4 w-4" />
                                                {skill.version.analysisState === "failed"
                                                    ? "Retry analysis"
                                                    : "Analyse"}
                                            </button>
                                        )}
                                    {skill.version.state === "draft" &&
                                        skill.version.analysisState === "succeeded" &&
                                        (!pendingEnable[skill.version.id] ? (
                                            <button
                                                type="button"
                                                disabled={busyVersion === skill.version.id}
                                                onClick={() => void proposeEnable(skill.version.id)}
                                                className="mt-3 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                                            >
                                                Propose enable
                                            </button>
                                        ) : (
                                            <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                                                <p>Confirm the exact pending enable action.</p>
                                                <button
                                                    type="button"
                                                    disabled={busyVersion === skill.version.id}
                                                    onClick={() => void confirmEnable(skill.version.id)}
                                                    className="mt-2 rounded-md bg-slate-950 px-3 py-2 text-white disabled:opacity-50"
                                                >
                                                    Confirm enable
                                                </button>
                                            </div>
                                        ))}
                                </div>
                            )}
                            {skill.version.state === "enabled" && (
                                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                                    <select
                                        aria-label={`Project for ${skill.displayName}`}
                                        value={projectByVersion[skill.version.id] ?? ""}
                                        onChange={(event) =>
                                            setProjectByVersion((current) => ({
                                                ...current,
                                                [skill.version.id]: event.target.value,
                                            }))
                                        }
                                        className="min-w-44 rounded-md border border-slate-300 px-3 py-2 text-sm"
                                    >
                                        <option value="">Select project…</option>
                                        {projects.map((project) => (
                                            <option key={project.id} value={project.id}>
                                                {project.name}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={busyVersion === skill.version.id}
                                        onClick={() => void run(skill)}
                                        className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"
                                    >
                                        <Play className="h-4 w-4" />
                                        Run skill
                                    </button>
                                </div>
                            )}
                            <div className="mt-4 border-t border-slate-100 pt-4">
                                {!packageInfo[skill.version.id] ? (
                                    <button
                                        type="button"
                                        disabled={busyVersion === skill.version.id}
                                        onClick={() => void showPackages(skill.version.id)}
                                        className="text-sm text-slate-600 underline-offset-4 hover:underline"
                                    >
                                        Package downloads
                                    </button>
                                ) : (
                                    <div className="text-sm text-slate-600">
                                        <p>
                                            {packageInfo[skill.version.id].licencePaths.length
                                                ? `Includes licence files: ${packageInfo[
                                                      skill.version.id
                                                  ].licencePaths.join(", ")}`
                                                : "No licence file was identified in the package."}
                                        </p>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void downloadPackage(
                                                        skill.version.id,
                                                        "original",
                                                    )
                                                }
                                                className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2"
                                            >
                                                <Download className="h-4 w-4" />
                                                Original ZIP
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void downloadPackage(
                                                        skill.version.id,
                                                        "mike",
                                                    )
                                                }
                                                className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2"
                                            >
                                                <Download className="h-4 w-4" />
                                                Mike package
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
