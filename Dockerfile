# Multi-stage build that produces a single image containing the backend
# Express app AND the static-exported Next.js frontend served from the
# same process. Replaces the previous backend-only Dockerfile.
#
# Build stages:
#   1. frontend-builder — runs `npm run build` against frontend/, which
#      emits a static export to /app/out (config: output: 'export').
#   2. backend-builder  — compiles the TypeScript backend to /app/dist.
#   3. runtime          — production-deps-only Node image with the
#      compiled backend + frontend output + migration SQL files. Express
#      serves the static frontend alongside its API routes.
#
# Build context is the repo root (not backend/) so we can COPY both
# subdirectories into the appropriate stage.

# ── Frontend build ───────────────────────────────────────────────────────────
FROM node:22-slim AS frontend-builder
WORKDIR /app

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

COPY frontend/package.json frontend/package-lock.json ./
# `--legacy-peer-deps` because @opennextjs/cloudflare (left over from a
# previous deploy-target experiment) peer-depends on an older Next.js
# range than the one we pin. We don't actually use OpenNext anymore —
# that dep can be removed in a later cleanup. Local dev has been
# bypassing this same warning via npm install's permissive mode.
RUN npm ci --ignore-scripts --legacy-peer-deps

COPY frontend/. ./
RUN npm run build
# Result: /app/out — static HTML, JS, CSS, fonts.

# ── Backend build ────────────────────────────────────────────────────────────
FROM node:22-slim AS backend-builder
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts

COPY backend/tsconfig.json ./
COPY backend/src ./src

RUN npm run build
# Result: /app/dist — compiled JS.

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# libreoffice-convert requires LibreOffice at runtime for DOCX → PDF conversion.
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=backend-builder /app/dist ./dist
# Frontend static output is served from /app/public via express.static.
COPY --from=frontend-builder /app/out ./public
# Migration files travel with the image so the migrate job uses the same artifact.
COPY backend/migrations ./migrations
# /install serves operator scripts from /app/scripts/install at request time
# (see GET /install/scripts/:name). Companion docs live alongside.
COPY scripts/install ./scripts/install

EXPOSE 8080
CMD ["node", "dist/index.js"]
