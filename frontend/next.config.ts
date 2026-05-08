import type { NextConfig } from "next";

// Static export: build → frontend/out/ produces pure HTML/JS/CSS that
// can be served from any static host (Container App, Static Web Apps,
// blob storage, etc.). The audit in docs/issues/azure-migration/
// 022-frontend-deployment.md confirms this app uses no SSR features —
// the only Next.js bits in play are font optimization, the Metadata
// API, and the App Router as a routing convenience. All page contents
// are "use client".
const nextConfig: NextConfig = {
    output: "export",
    reactCompiler: true,
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
