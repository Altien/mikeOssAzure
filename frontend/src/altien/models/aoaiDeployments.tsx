"use client";

/**
 * Azure OpenAI deployment discovery (dev-only, OSS-6 §2.3 item 3).
 *
 * AOAI availability is per-deployment: the organisation configures an
 * endpoint + key (Key Vault), and the model pickers offer whichever
 * deployments `GET /llm/azure-openai/deployments` reports, as
 * `aoai:<deployment>` model ids. The list is fetched once per signed-in
 * user and shared by every picker; `reload()` is the only refetch trigger
 * (deployments rarely change and the AOAI management call is paid).
 *
 * Lives outside upstream's UserProfileContext so that file stays upstream's.
 * `useAoaiDeployments()` does not throw without the provider — it returns an
 * empty list, so upstream components that call it (ModelToggle) still render
 * in isolation.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { apiRequest } from "@/app/lib/mikeApi";
import type { ModelOption } from "@/app/components/assistant/ModelToggle";

export type AoaiDeployment = {
    name: string;
    model: string | null;
};

type AoaiDeploymentsValue = {
    deployments: AoaiDeployment[];
    /** The deployments as model-picker entries (`aoai:<name>` ids). */
    modelOptions: ModelOption[];
    loading: boolean;
    error: string | null;
    reload: () => Promise<void>;
};

const EMPTY: AoaiDeploymentsValue = {
    deployments: [],
    modelOptions: [],
    loading: false,
    error: null,
    reload: async () => {},
};

const AoaiDeploymentsContext = createContext<AoaiDeploymentsValue>(EMPTY);

export function toAoaiModelOptions(
    deployments: AoaiDeployment[],
): ModelOption[] {
    return deployments.map((d) => ({
        id: `aoai:${d.name}`,
        // Deployment name first (what the customer recognises), with the
        // underlying base model as a hint when AOAI exposes one.
        label: d.model ? `${d.name} (${d.model})` : d.name,
        group: "Azure OpenAI" as const,
    }));
}

export function AoaiDeploymentsProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const userId = user?.id ?? null;
    const [deployments, setDeployments] = useState<AoaiDeployment[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await apiRequest<{
                source: "personal" | "global" | null;
                deployments: AoaiDeployment[];
            }>("/llm/azure-openai/deployments");
            setDeployments(data.deployments ?? []);
        } catch (err) {
            console.error("[aoai-deployments] fetch failed", err);
            setDeployments([]);
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to list Azure OpenAI deployments",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && userId) {
            void reload();
        } else {
            setDeployments([]);
            setError(null);
        }
    }, [isAuthenticated, userId, reload]);

    const value = useMemo<AoaiDeploymentsValue>(
        () => ({
            deployments,
            modelOptions: toAoaiModelOptions(deployments),
            loading,
            error,
            reload,
        }),
        [deployments, loading, error, reload],
    );

    return (
        <AoaiDeploymentsContext.Provider value={value}>
            {children}
        </AoaiDeploymentsContext.Provider>
    );
}

export function useAoaiDeployments(): AoaiDeploymentsValue {
    return useContext(AoaiDeploymentsContext);
}
