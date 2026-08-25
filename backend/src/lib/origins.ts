export function configuredAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const developmentOrigins =
    env.NODE_ENV === "production"
      ? []
      : [
          ...(env.FRONTEND_URL ? [] : ["http://localhost:3000"]),
          ...(env.WORD_ADDIN_URL ? [] : ["https://localhost:3200"]),
        ];

  return new Set(
    [
      env.FRONTEND_URL ?? "http://localhost:3000",
      env.WORD_ADDIN_URL,
      ...(env.ALLOWED_ORIGINS ?? "").split(","),
      ...developmentOrigins,
    ]
      .map((origin) => origin?.trim().replace(/\/$/, ""))
      .filter((origin): origin is string => !!origin),
  );
}

export function requestOriginIsTrusted(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return false;
  try {
    return configuredAllowedOrigins(env).has(new URL(origin).origin);
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
    return new URL(origin).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}
