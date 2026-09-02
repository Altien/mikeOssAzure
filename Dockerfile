# Multi-stage build that produces a single image containing the backend
# Express app AND the static-exported Next.js frontend served from the
# same process. Replaces the previous backend-only Dockerfile.
#
# Build stages:
#   1. frontend-builder — runs `pnpm run build` against frontend/, which
#      emits a static export to /app/out (config: output: 'export').
#   2. backend-builder  — compiles the TypeScript backend to /app/dist.
#   3. runtime          — production-deps-only Node image with the
#      compiled backend + frontend output + migration SQL files. Express
#      serves the static frontend alongside its API routes.
#
# Build context is the repo root (not backend/) so we can COPY both
# subdirectories into the appropriate stage.
#
# Package manager is pnpm — pinned per-package via the `packageManager`
# field in package.json and activated via `corepack enable`. The
# `pnpm-workspace.yaml` files carry the `allowBuilds` allowlist that
# gates which dependencies may run install scripts; this is the
# supply-chain hardening mechanism that replaces `npm ci --ignore-scripts`.

# ── Frontend build ───────────────────────────────────────────────────────────
FROM node:22-slim AS frontend-builder
WORKDIR /app
RUN corepack enable

# NEXT_PUBLIC_API_BASE_URL is the only build-arg the frontend bundle
# needs to know at compile time, because Next.js inlines NEXT_PUBLIC_*
# values into the JS bundle (output: 'export' has no Node runtime to
# read env at request time).
#
# Default empty = same-origin: the bundled-deploy serves the frontend
# from the same Express process that exposes the API, so client-side
# fetches use relative URLs. Override with --build-arg if frontend
# and backend live on different origins.
#
# All other runtime config (authProvider, Entra IDs, etc.) is now
# served by the backend's GET /config and resolved in the browser at
# startup — see frontend/src/contexts/ConfigContext.tsx.  The image
# is therefore tenant-portable; rebuilding per customer is no longer
# required.
ARG NEXT_PUBLIC_API_BASE_URL=
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/.npmrc frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend/. ./
RUN pnpm run build
# Result: /app/out — static HTML, JS, CSS, fonts.

# ── Backend build ────────────────────────────────────────────────────────────
FROM node:22-slim AS backend-builder
WORKDIR /app
RUN corepack enable

COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY backend/tsconfig.json ./
COPY backend/src ./src

RUN pnpm run build
# Result: /app/dist — compiled JS.

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
RUN corepack enable
# Keep npm's bundled `tar` above the patched floor used by the migration job's
# `npm run migrate` entrypoint (CVE-2026-59873). The floor moved to 7.5.19;
# npm@12.0.1 shipped 7.5.15, npm@12.0.2 depends on ^7.5.19.
RUN npm install --global npm@12.0.2

# libreoffice-convert requires LibreOffice at runtime for DOCX → PDF conversion.
# libnss3 is named explicitly so the bookworm security update lands
# (CVE-2026-16389, fixed in 2:3.87.1-1+deb12u4) rather than whatever the
# base image froze at.
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice libnss3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc backend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod \
 && corepack disable \
 && rm -rf /usr/local/lib/node_modules/corepack \
 && rm -rf /root/.cache/node/corepack

COPY --from=backend-builder /app/dist ./dist
# Frontend static output is served from /app/public via express.static.
COPY --from=frontend-builder /app/out ./public
# Migration files travel with the image so the migrate job uses the same artifact.
COPY backend/migrations ./migrations
# User-facing help guides, served by GET /api/help/articles. Only docs/help
# ships — the rest of docs/ is written for contributors and operators.
COPY docs/help ./docs/help
# /install serves operator scripts from /app/scripts/install at request time
# (see GET /install/scripts/:name). Companion docs live alongside.
COPY scripts/install ./scripts/install

EXPOSE 8080
CMD ["node", "dist/index.js"]
