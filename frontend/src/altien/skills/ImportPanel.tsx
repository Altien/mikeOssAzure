import type { RefObject } from "react";
import { Upload } from "lucide-react";
import type { GitHubSkillImportPolicy, SkillCatalogItem } from "./api";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

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
    catalogSkills,
    catalogId,
    onCatalogIdChange,
    onImportCatalog,
}: {
    canManage: boolean;
    importing: boolean;
    fileInput: RefObject<HTMLInputElement | null>;
    onImportFile: (file: File) => void;
    githubPolicy: GitHubSkillImportPolicy | null;
    githubUrl: string;
    onGithubUrlChange: (value: string) => void;
    onImportGitHub: () => void;
    catalogSkills: SkillCatalogItem[];
    catalogId: string;
    onCatalogIdChange: (value: string) => void;
    onImportCatalog: () => void;
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

            {canManage && catalogSkills.length > 0 && (
                <section aria-label="Altien skill catalog" className="mt-6 rounded-xl border border-border bg-app-surface p-4">
                    <h2 className="text-sm font-medium text-foreground">Altien catalog</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Install a copy to review and enable for your organisation.</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <select aria-label="Altien catalog skill" value={catalogId}
                            disabled={importing} onChange={(event) => onCatalogIdChange(event.target.value)}
                            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <option value="">Choose a skill</option>
                            {catalogSkills.map((skill) => <option key={skill.id} value={skill.id}>{skill.displayName}</option>)}
                        </select>
                        <PillButtonUI tone="black" disabled={importing || !catalogId} onClick={onImportCatalog}>Install from Altien</PillButtonUI>
                    </div>
                    {catalogId && <p className="mt-2 text-sm text-muted-foreground">{catalogSkills.find((skill) => skill.id === catalogId)?.description}</p>}
                </section>
            )}

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
