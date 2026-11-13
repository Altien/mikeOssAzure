/** Key Vault answered that the secret does not exist, as opposed to not answering. */
export function isSecretNotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: unknown; statusCode?: unknown };
    return e.code === "SecretNotFound" || e.statusCode === 404;
}
