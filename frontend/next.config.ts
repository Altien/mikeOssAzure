import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

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
    typescript: {
        // `next build` type-checks this program instead of tsconfig.json. It
        // excludes test files, so the static export never depends on test
        // fixtures or sibling apps. Tests are type-checked by `pnpm run
        // typecheck` (tsc over tsconfig.json) in CI instead.
        tsconfigPath: "tsconfig.build.json",
    },
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
    // Upstream divergence (317a8f05): upstream's `redirects()` /account ->
    // /settings is NOT carried -- unsupported under `output: "export"`. Dev has
    // client pages at (pages)/account/** that router.replace to /settings/**.
    skipTrailingSlashRedirect: true,
};

// Sentry's build plugin wires the instrumentation files above into the
// bundle. Source-map upload (readable stack traces in Sentry) only happens
// when SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT are present at build
// time; without them the build is unchanged and no maps leave the machine.
const sourceMapUploadConfigured = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
        process.env.SENTRY_ORG &&
        process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    telemetry: false,
    sourcemaps: {
        disable: !sourceMapUploadConfigured,
        // Upload the maps for debugging, then keep them out of the image.
        deleteSourcemapsAfterUpload: true,
    },
    widenClientFileUpload: sourceMapUploadConfigured,
    // Route browser events through this origin so ad blockers that block
    // *.sentry.io do not hide client-side errors. Only applies to sentry.io
    // DSNs; self-hosted or local DSNs post directly.
    tunnelRoute: "/monitoring",
});
