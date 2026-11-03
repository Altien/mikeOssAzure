import { describe, expect, it } from "vitest";
import { redactDownloadPath, redactDownloadSpan } from "../downloadRedaction";

describe("download credential redaction", () => {
  it("redacts relative and absolute paths including error-log fallback paths", () => {
    expect(redactDownloadPath("GET /api/download/payload.signature?other=1")).toBe("GET /api/download/[redacted]?other=1");
    expect(redactDownloadPath("https://app.test/api/download/payload.signature")).toBe("https://app.test/api/download/[redacted]");
    expect(redactDownloadPath("/api/single-documents/doc/file")).toBe("/api/single-documents/doc/file");
  });

  it("redacts App Insights span names, request URLs, targets and event fields", () => {
    const span = { name: "GET /api/download/payload.signature", attributes: { "http.url": "https://app.test/api/download/payload.signature", "url.path": "/api/download/payload.signature", "http.target": "/api/download/payload.signature", "http.status_code": 200 }, events: [{ attributes: { message: "failed /api/download/payload.signature" } }] };
    redactDownloadSpan(span);
    expect(JSON.stringify(span)).not.toContain("payload.signature");
    expect(span.name).toBe("GET /api/download/[redacted]");
    expect(span.attributes["http.status_code"]).toBe(200);
  });
});
