/** Strip the credential segment from URLs, request names and log paths. */
export function redactDownloadPath(value: string): string {
  return value.replace(/(\/download\/)[^/?#\s]+/gi, "$1[redacted]");
}

type DownloadSpan = {
  name: string;
  attributes: Record<string, unknown>;
  events?: { attributes?: Record<string, unknown> }[];
};

/** The SDK's ended span is read by exporters after processors run. */
export function redactDownloadSpan(span: DownloadSpan): void {
  span.name = redactDownloadPath(span.name);
  const redact = (attributes: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "string") attributes[key] = redactDownloadPath(value);
      else if (Array.isArray(value)) attributes[key] = value.map(item => typeof item === "string" ? redactDownloadPath(item) : item);
    }
  };
  redact(span.attributes);
  for (const event of span.events ?? []) if (event.attributes) redact(event.attributes);
}
