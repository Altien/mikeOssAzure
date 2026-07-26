"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, PackageOpen } from "lucide-react";
import {
    importSkillZip,
    listSkills,
    type SkillListItem,
} from "./api";

function messageFrom(error: unknown) {
    return error instanceof Error ? error.message : "The request failed.";
}

export function SkillsLibrary() {
    const [skills, setSkills] = useState<SkillListItem[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
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
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
