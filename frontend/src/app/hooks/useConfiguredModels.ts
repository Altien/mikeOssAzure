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
        // Use the shared catalog when it is already loaded. Invalidation is
        // the provider's job: UserProfileProvider clears/refreshes it on every
        // sign-in and user change and after an API-key save, so a mount never
        // sees a stale user's catalog. Forcing a refetch here instead meant
        // every picker that mounted after the provider's request had resolved
        // (the page chunk always mounts later than the shell) sent a second
        // GET /models/configured per page load (MIKE-FRONTEND-C).
        void load().then(update);
        return () => {
            listeners.delete(update);
        };
    }, []);

    return models;
}
