const AUTH_REDIRECT_PATHS = new Set([
    "/assistant",
    "/login",
    "/reset-password",
    "/settings",
]);

export function safeAuthNext(
    candidate: string | null | undefined,
    fallback = "/assistant",
): string {
    if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
        return fallback;
    }
    if (candidate.includes("\\") || /[\u0000-\u001f\u007f]/.test(candidate)) {
        return fallback;
    }

    const base = new URL("https://auth.mike.local");
    const resolved = new URL(candidate, base);
    if (
        resolved.origin !== base.origin ||
        !AUTH_REDIRECT_PATHS.has(resolved.pathname)
    ) {
        return fallback;
    }
    return `${resolved.pathname}${resolved.search}`;
}

export function authCallbackUrl(origin: string, next: string): string {
    const callback = new URL("/auth/callback", origin);
    callback.searchParams.set("next", safeAuthNext(next));
    return callback.toString();
}

export function browserAuthCallbackUrl(next: string): string | undefined {
    if (typeof window === "undefined") return undefined;
    return authCallbackUrl(window.location.origin, next);
}

export function authErrorDescription(
    search: string,
    hash: string,
): string | null {
    const query = new URLSearchParams(search);
    const fragment = new URLSearchParams(hash.replace(/^#/, ""));
    return (
        query.get("error_description") ||
        query.get("error") ||
        fragment.get("error_description") ||
        fragment.get("error")
    );
}
