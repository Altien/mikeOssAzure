"use client";

import { useEffect, useState } from "react";
import {
    getOpenCodeGoModels,
    type OpenCodeGoModelOption,
} from "@/app/lib/mikeApi";

let cache: OpenCodeGoModelOption[] | null = null;
let inflight: Promise<OpenCodeGoModelOption[]> | null = null;
const listeners = new Set<() => void>();

function load(force = false): Promise<OpenCodeGoModelOption[]> {
    if (force) {
        cache = null;
        inflight = null;
    }
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        inflight = getOpenCodeGoModels()
            .then((models) => {
                // The router catalog endpoint returns bare {id,label}; the
                // composer groups options, so tag them here.
                cache = models.map((model) => ({
                    ...model,
                    group: "OpenCode Go" as const,
                }));
                inflight = null;
                listeners.forEach((listener) => listener());
                return cache;
            })
            .catch(() => {
                inflight = null;
                return [] as OpenCodeGoModelOption[];
            });
    }
    return inflight;
}

export function refreshOpenCodeGoModels(): Promise<OpenCodeGoModelOption[]> {
    return load(true);
}

export function useOpenCodeGoModels(
    enabled: boolean,
): OpenCodeGoModelOption[] {
    const [models, setModels] = useState<OpenCodeGoModelOption[]>(cache ?? []);

    useEffect(() => {
        if (!enabled) return;
        const update = () => setModels(cache ?? []);
        listeners.add(update);
        void load().then(update);
        return () => {
            listeners.delete(update);
        };
    }, [enabled]);

    return enabled ? models : [];
}
