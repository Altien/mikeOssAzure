import path from "node:path";
import type { NextConfig } from "next";

// The repository root: the parent of this directory, here and in the Docker
// image (dev's root Dockerfile mirrors the layout at /app/frontend and
// /app/packages). The shared packages the app imports, @mike/ui and
// @mike/client (packages/ui, packages/client), live there.
const REPO_ROOT = path.resolve(__dirname, "..");

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
    // Browser source maps only for a build whose maps scripts/upload-sourcemaps.mjs
    // sends to Sentry and then deletes (sync-log: 3bcac35a); never shipped.
    productionBrowserSourceMaps: process.env.SENTRY_UPLOAD_ENABLED === "1",
    typescript: {
        // `next build` type-checks this program instead of tsconfig.json. It
        // excludes test files, so the static export never depends on test
        // fixtures or sibling apps. Tests are type-checked by `pnpm run
        // typecheck` (tsc over tsconfig.json) in CI instead.
        tsconfigPath: "tsconfig.build.json",
    },
    turbopack: {
        // Turbopack resolves nothing outside its root, and Next uses the same
        // directory as outputFileTracingRoot (the two must agree). The root
        // is therefore the repository, so the tsconfig `paths` aliases for the
        // shared packages resolve; standalone output nests under frontend/.
        root: REPO_ROOT,
    },
    experimental: {
        // Webpack builds (`next build --webpack`, used for the desktop app's
        // standalone server) transpile only files under this directory unless
        // told otherwise; the shared packages live one level up.
        externalDir: true,
    },
    webpack: (config) => {
        // The shared packages have no node_modules of their own. A bare import
        // from a file under packages/ walks up to the repository root and never
        // reaches this directory's node_modules, so add it as the fallback
        // (word-addin/webpack.config.js does the same for the add-in).
        config.resolve.modules = [
            ...(config.resolve.modules ?? ["node_modules"]),
            path.join(__dirname, "node_modules"),
        ];
        return config;
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

// Upstream divergence (sync-log: 3bcac35a): upstream wraps this config in
// @sentry/nextjs `withSentryConfig` for release naming and map upload, and its
// browser SDK tunnels through a Next `/monitoring` route handler. Dev's static
// export has neither @sentry/nextjs nor route handlers: the tunnel is the
// backend's POST /api/monitoring, and maps are uploaded after the export.
export default nextConfig;
