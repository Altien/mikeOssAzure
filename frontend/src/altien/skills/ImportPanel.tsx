import type { RefObject } from "react";
import { Upload } from "lucide-react";
import type { GitHubSkillImportPolicy } from "./api";

/** Library heading plus the ZIP and GitHub import controls. */
export function ImportPanel({
    canManage,
    importing,
    fileInput,
    onImportFile,
    githubPolicy,
    githubUrl,
    onGithubUrlChange,
    onImportGitHub,
}: {
    canManage: boolean;
    importing: boolean;
    fileInput: RefObject<HTMLInputElement | null>;
    onImportFile: (file: File) => void;
    githubPolicy: GitHubSkillImportPolicy | null;
    githubUrl: string;
    onGithubUrlChange: (value: string) => void;
    onImportGitHub: () => void;
}) {
    return (
        <>
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
                                if (file) onImportFile(file);
                            }}
                        />
                    </label>
                )}
            </div>

            {canManage && githubPolicy?.effectiveEnabled && (
                <div className="mt-6 flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-4">
                    <input
                        value={githubUrl}
                        onChange={(event) => onGithubUrlChange(event.target.value)}
                        placeholder="https://github.com/owner/repository/tree/ref/path"
                        aria-label="GitHub skill URL"
                        className="min-w-72 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button
                        type="button"
                        disabled={importing || !githubUrl.trim()}
                        onClick={onImportGitHub}
                        className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
                    >
                        Import from GitHub
                    </button>
                </div>
            )}
        </>
    );
}
