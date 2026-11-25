/**
 * Response headers for the static web app this backend serves.
 *
 * Upstream 84805159 attaches frontend/src/app/lib/securityHeaders.ts to every
 * page through next.config.ts `headers()`. Dev divergence: the web app is a
 * static export (`output: "export"` ignores `headers()`) served by this
 * backend's static-frontend block in app.ts, so the same set is sent from
 * here. The backend cannot import the frontend tree, so this is a copy;
 * frontendSecurityHeaders.test.ts fails when the two drift.
 *
 * Applied after helmet, so these values replace helmet's API defaults for
 * web-app responses (X-Frame-Options DENY rather than SAMEORIGIN, and
 * strict-origin-when-cross-origin rather than no-referrer, which would strip
 * the origin Google checks against the Picker's referrer-restricted key).
 */

import type { RequestHandler } from "express";

export type HeaderEntry = { key: string; value: string };

/** 180 days, matching the API's helmet HSTS setting. */
const HSTS = "max-age=15552000; includeSubDomains";

const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

function reportOnlyCsp(production: boolean): string {
  return [
    "default-src 'self'",
    [
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      ...(production ? [] : ["'unsafe-eval'"]),
      "https://apis.google.com https://static.cloudflareinsights.com",
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com",
    "connect-src 'self' blob: data: https:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: https://docs.google.com",
    "form-action 'self'",
    ENFORCED_CSP,
  ].join("; ");
}

export function frontendSecurityHeaders(production: boolean): HeaderEntry[] {
  return [
    { key: "Content-Security-Policy", value: ENFORCED_CSP },
    {
      key: "Content-Security-Policy-Report-Only",
      value: reportOnlyCsp(production),
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    ...(production ? [{ key: "Strict-Transport-Security", value: HSTS }] : []),
  ];
}

/**
 * Sets the web-app headers on every response the static-frontend block
 * serves, except /api (upstream 29240e98): an unmatched API path keeps the
 * backend's own stricter helmet headers.
 */
export function sendFrontendSecurityHeaders(production: boolean): RequestHandler {
  const headers = frontendSecurityHeaders(production);
  return (req, res, next) => {
    if (/^\/api(?:\/|$)/.test(req.path)) return next();
    for (const { key, value } of headers) res.setHeader(key, value);
    next();
  };
}
