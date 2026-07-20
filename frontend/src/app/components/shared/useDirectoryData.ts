"use client";

import { useEffect, useState } from "react";
import { listProjects, listStandaloneDocuments } from "@/app/lib/mikeApi";
import type { Document, Project } from "./types";

const CACHE_TTL_MS = 30_000;

interface DirectoryCache {
    standaloneDocuments: Document[];
    projects: Project[];
    fetchedAt: number;
}

let cache: DirectoryCache | null = null;

export function invalidateDirectoryCache() {
    cache = null;
}

export function useDirectoryData(enabled: boolean) {
    const [loading, setLoading] = useState(true);
    const [standaloneDocuments, setStandaloneDocuments] = useState<Document[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);

    useEffect(() => {
        if (!enabled) return;

        const now = Date.now();
        if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
            setStandaloneDocuments(cache.standaloneDocuments);
            setProjects(cache.projects);
            setLoading(false);
            return;
        }

        setLoading(true);
        // One batched request for projects + their documents. Fanning out
        // getProject(id) per project caused an N+1 request burst on every
        // directory-modal open (upstream 36cddb2).
        Promise.all([
            listProjects({ includeDocuments: true }),
            listStandaloneDocuments(),
        ])
            .then(([ps, ds]) => {
                const sorted = [...ds].sort((a, b) =>
                    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                );
                cache = {
                    standaloneDocuments: sorted,
                    projects: ps,
                    fetchedAt: Date.now(),
                };
                setStandaloneDocuments(sorted);
                setProjects(ps);
            })
            .catch(() => {
                setStandaloneDocuments([]);
                setProjects([]);
            })
            .finally(() => setLoading(false));
    }, [enabled]);

    return { loading, standaloneDocuments, projects };
}
