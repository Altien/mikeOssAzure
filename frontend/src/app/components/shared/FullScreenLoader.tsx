/**
 * The single full-screen loading state. Every gate in the provider/layout
 * chain (Suspense fallback, MFA gate, auth-loading layout) must render this
 * exact markup: the server and client can resolve those gates differently on
 * first paint, and identical DOM is what keeps that from being a hydration
 * mismatch.
 */
export function FullScreenLoader() {
    return (
        <div className="flex min-h-dvh items-center justify-center bg-gray-50/80">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
        </div>
    );
}
