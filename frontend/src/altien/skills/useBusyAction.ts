"use client";

import { useCallback, useState } from "react";

export function messageFrom(error: unknown) {
    return error instanceof Error ? error.message : "The request failed.";
}

export type BusyActionOptions = {
    /**
     * Leaves the busy key set when the action resolves. Used by handlers that
     * navigate away on success, so their control stays disabled until unmount.
     */
    keepBusyOnSuccess?: boolean;
    /** Runs once the busy key is released, on both success and failure. */
    onSettled?: () => void;
};

/**
 * Wraps the "mark busy, clear the error, run, report failures, clear busy"
 * ritual every Skills-library handler repeats. `busyKey` identifies which
 * control is in flight (a skill version id, or a fixed key for page-level
 * actions).
 */
export function useBusyAction<TKey>(
    setError: (message: string | null) => void,
) {
    const [busyKey, setBusyKey] = useState<TKey | null>(null);

    const run = useCallback(
        async (
            key: TKey,
            action: () => Promise<void>,
            options: BusyActionOptions = {},
        ) => {
            setBusyKey(key);
            setError(null);
            let failed = false;
            try {
                await action();
            } catch (caught) {
                failed = true;
                setError(messageFrom(caught));
            } finally {
                if (failed || !options.keepBusyOnSuccess) setBusyKey(null);
                options.onSettled?.();
            }
        },
        [setError],
    );

    return [busyKey, run] as const;
}
