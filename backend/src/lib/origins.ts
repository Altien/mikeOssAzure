export function configuredAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const normalize = (value: string | undefined): string | null => {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return url.origin;
    } catch { return null; }
  };
  const developmentOrigins =
    env.NODE_ENV === "production"
      ? []
      : [
          ...(env.FRONTEND_URL ? [] : ["http://localhost:3000"]),
          ...(env.WORD_ADDIN_URL ? [] : ["https://localhost:3200"]),
        ];

  return new Set(
    [
      env.FRONTEND_URL,
      env.WORD_ADDIN_URL,
      ...(env.ALLOWED_ORIGINS ?? "").split(","),
      ...developmentOrigins,
    ]
      .map(normalize)
      .filter((origin): origin is string => !!origin),
  );
}

export function requestOriginIsTrusted(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && configuredAllowedOrigins(env).has(origin);
  } catch {
    return false;
  }
}

export function requestOriginIsWordAddin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured =
    env.WORD_ADDIN_URL?.trim() ||
    (env.NODE_ENV === "production" ? "" : "https://localhost:3200");
  if (!origin || !configured) return false;
  try {
    return origin === new URL(origin).origin && origin === new URL(configured).origin;
  } catch {
    return false;
  }
}
