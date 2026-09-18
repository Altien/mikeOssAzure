import { useEffect, useState } from "react";
import {
    getConfiguredModels,
    type ConfiguredModelOption,
} from "@/app/lib/mikeApi";

// Deployment configuration is shared by every picker. Keep one request and
// notify all mounted consumers when it resolves, just like Ollama discovery.
let cache: ConfiguredModelOption[] | null = null;
let inflight: Promise<ConfiguredModelOption[]> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function load(force = false): Promise<ConfiguredModelOption[]> {
    if (force) {
        generation += 1;
        cache = null;
        inflight = null;
    }
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        const requestGeneration = generation;
        const request: Promise<ConfiguredModelOption[]> = getConfiguredModels()
            .then((models) => {
                if (requestGeneration !== generation) return models;
                cache = models;
                listeners.forEach((listener) => listener());
                return models;
            })
            .catch(() => {
                if (requestGeneration === generation) {
                    listeners.forEach((listener) => listener());
                }
                return [];
            })
            .finally(() => {
                if (inflight === request) inflight = null;
            });
        inflight = request;
    }
    return inflight;
}

export function refreshConfiguredModels(): Promise<ConfiguredModelOption[]> {
    return load(true);
}

export function clearConfiguredModels(): void {
    generation += 1;
    cache = null;
    inflight = null;
    listeners.forEach((listener) => listener());
}

export function useConfiguredModels(): ConfiguredModelOption[] {
    const [models, setModels] = useState<ConfiguredModelOption[]>(cache ?? []);

    useEffect(() => {
        const update = () => setModels(cache ?? []);
        listeners.add(update);
        // Revalidate on mount so a previous user's catalog or a catalog
        // loaded before an API-key change cannot remain authoritative.
        void load(cache !== null).then(update);
        return () => {
            listeners.delete(update);
        };
    }, []);

    return models;
}
