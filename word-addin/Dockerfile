# Build from the repository root: `docker build -f word-addin/Dockerfile .`
# The add-in bundles the packages it shares with the web app (packages/ui and
# packages/client, reached through webpack aliases, tsconfig paths, and a
# Tailwind @source entry), the web app's icons (frontend/public/icons, the
# @icons alias), and the @mike/contracts declarations. Nothing else outside
# word-addin/ is read.
# Azure's Word image keeps the shared packages and contracts at their workspace
# paths while retaining the fork's pnpm installation and same-origin /api.
FROM node:22-slim AS build
WORKDIR /app/word-addin
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY word-addin/package.json word-addin/pnpm-lock.yaml word-addin/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY word-addin/ ./
COPY frontend/public/icons/ /app/frontend/public/icons/
COPY packages/contracts/ /app/packages/contracts/
COPY packages/ui/ /app/packages/ui/
COPY packages/client/ /app/packages/client/
# Release identity (docs/observability.md): mike@<version>+<sha12>. The DSN
# is not baked; the pane reads it from runtime /config.
ARG MIKE_VERSION=
ARG GIT_SHA=
ENV REACT_APP_API_BASE_URL=/api REACT_APP_WEB_APP_URL="" \
    REACT_APP_MIKE_VERSION=$MIKE_VERSION \
    REACT_APP_GIT_SHA=$GIT_SHA
# Sentry source-map upload (webpack.config.js), adopted with 3bcac35a.
# Upstream divergence (sync-log: 3bcac35a): upstream mounts the token as a
# BuildKit secret. Dev builds with `az acr build`, which has no BuildKit
# secret mounts, so deploy.ps1 / scripts/release-images.sh resolve the token
# (Key Vault first, SENTRY_AUTH_TOKEN env fallback) and pass it with
# --secret-build-arg (masked in ACR logs). It is read only in this build stage;
# the runtime stage below starts from a fresh base and never sees it.
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
ARG SENTRY_UPLOAD_ENABLED=0
ARG SENTRY_AUTH_TOKEN=
RUN case "$SENTRY_UPLOAD_ENABLED" in \
      0) unset SENTRY_AUTH_TOKEN ;; \
      1) if [ -z "$SENTRY_AUTH_TOKEN" ] || [ -z "$SENTRY_ORG" ] || [ -z "$SENTRY_PROJECT" ]; then \
           echo "Sentry upload requires SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT" >&2; exit 1; \
         fi ;; \
      *) echo "SENTRY_UPLOAD_ENABLED must be 0 or 1" >&2; exit 1 ;; \
    esac; \
    pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/word-addin/dist ./dist
COPY --from=build /app/word-addin/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
