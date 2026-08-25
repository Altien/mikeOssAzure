export const AUTH_SESSION_INVALIDATED_EVENT = "mike:auth-session-invalidated";

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
