// Types and helpers shared by the health check topic files. Not on the facade,
// apart from the result types the routes render.

export type HealthStatus = "pass" | "warn" | "fail" | "info" | "skip";

/** What a check decides. `detail` is one line of statuses, counts, names and codes. */
export type CheckOutcome = { status: HealthStatus; detail: string; remediation?: string };

export type HealthResult = CheckOutcome & { id: string; group: string; title: string };

export type HealthCheck = {
    id: string;
    group: string;
    title: string;
    run: (signal: AbortSignal) => Promise<CheckOutcome>;
};

/**
 * How a corrected Key Vault value reaches the backend, as a clause. Current Bicep
 * sets no ENTRA_* env, so getConfig reads Key Vault through its cache; a hand-added
 * env reference wins and resolves only at revision start. Same "set" test as
 * getConfig: empty and the Bicep placeholder fall through. Only for names the
 * backend reads through getConfig: see REVISION_REQUIRED_SECRETS in platform.health.ts.
 */
export function configPickup(settings: string[]): string {
    const winning = settings
        .map((setting) => setting.toUpperCase().replaceAll("-", "_"))
        .filter((envName) => {
            const value = process.env[envName];
            return value && value !== "__unset__";
        });
    if (winning.length) {
        const references = winning.join(" and ");
        const wins = winning.length > 1 ? "win" : "wins";
        const reference = winning.length > 1 ? "references" : "reference";
        return `then create a new backend revision, because the env ${reference} ${references} ${wins} over Key Vault and resolves only at revision start`;
    }
    const subject = settings.length > 1 ? "they take" : "it takes";
    return `and ${subject} effect within about 5 minutes, when the backend's config cache expires, with no new revision needed`;
}

/** A database or SDK error's code and HTTP status; never its message. */
export function errorSummary(error: unknown): string {
    const source = (error ?? {}) as { code?: unknown; status?: unknown; statusCode?: unknown };
    const code = typeof source.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(source.code)
        ? source.code
        : "";
    const http = source.status ?? source.statusCode;
    const parts = [
        ...(code ? [`code ${code}`] : []),
        ...(typeof http === "number" && http > 0 ? [`HTTP ${http}`] : []),
    ];
    return parts.join(", ") || "no error code";
}

/** Throw a supabase-js `{ error, status }` as a value carrying only its code and status. */
export function codedFailure(error: { code?: unknown } | null | undefined, status?: number): Error {
    return Object.assign(new Error("Health check query failed"), { code: error?.code, status });
}
