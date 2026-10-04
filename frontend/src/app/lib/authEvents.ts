export const AUTH_SESSION_INVALIDATED_EVENT = "mike:auth-session-invalidated";
let authEpoch = 0;
const epochListeners = new Set<() => void>();
export function currentAuthEpoch(): number { return authEpoch; }
export function advanceAuthEpoch(): void {
    authEpoch += 1;
    for (const listener of [...epochListeners]) listener();
}
export function subscribeAuthEpoch(listener: () => void): () => void {
    epochListeners.add(listener);
    return () => { epochListeners.delete(listener); };
}

/**
 * Fetch an authenticated application resource and immediately invalidate the
 * browser's in-memory auth state when the backend rejects the session.
 */
export async function authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const response = await globalThis.fetch(input, {
        ...init,
        credentials: "include",
    });

    if (response.status === 401 && typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    }

    return response;
}
