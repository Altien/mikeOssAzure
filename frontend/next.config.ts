import type { NextConfig } from "next";

// Static export: build → frontend/out/ produces pure HTML/JS/CSS that
// can be served from any static host (Container App, Static Web Apps,
// blob storage, etc.). This app uses no SSR features; the Next.js
// features in play are font optimization, the Metadata API, and the
// App Router as a routing convenience. All page contents are "use client".
const nextConfig: NextConfig = {
    // ponytail: export only for the bundled build. `next dev` (NODE_ENV
    // development) skips it so dynamic routes like /projects/[id] don't
    // demand generateStaticParams; `next build`/`pnpm bundle` still export.
    output: process.env.NODE_ENV === "production" ? "export" : undefined,
    reactCompiler: true,
    turbopack: {
        root: __dirname,
    },
    // Upstream divergence (sync-log: 4728fd19): the sitemap `rewrites()` in
    // upstream's config is intentionally NOT carried -- dev is a static
    // export (rewrites are unsupported) and has no /api/sitemap route.
    // Upstream divergence (sync-log: 3743f26d): upstream throws at build time
    // when NEXT_PUBLIC_SUPABASE_* / NEXT_PUBLIC_API_BASE_URL are unset. NOT
    // carried -- dev uses runtime config (GET /config via ConfigContext); the
    // only build-time var is the optional NEXT_PUBLIC_API_BASE_URL (may be empty).
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
