# Build from the repository root: `docker build -f word-addin/Dockerfile .`
# The add-in bundles the UI it shares with the web app (frontend/src/shared,
# reached through webpack aliases, tsconfig paths, and Tailwind @source
# entries), the web app's icons (frontend/public/icons, the @icons alias), and
# the @mike/contracts declarations. Nothing else outside word-addin/ is read.
# Azure's Word image keeps the shared UI and contracts at their workspace
# paths while retaining the fork's pnpm installation and same-origin /api.
FROM node:22-slim AS build
WORKDIR /app/word-addin
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY word-addin/package.json word-addin/pnpm-lock.yaml word-addin/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY word-addin/ ./
COPY frontend/src/shared/ /app/frontend/src/shared/
COPY frontend/public/icons/ /app/frontend/public/icons/
COPY packages/contracts/ /app/packages/contracts/
ENV REACT_APP_API_BASE_URL=/api REACT_APP_WEB_APP_URL=""
# Upstream divergence (sync-log: 71cd0286, 95f2711c): upstream passes
# SENTRY_ORG/SENTRY_PROJECT build args and a SENTRY_AUTH_TOKEN BuildKit secret
# here for its webpack source-map upload. Dev's add-in has no Sentry webpack
# plugin (see webpack.config.js, sync-log 54b6b3a1), so nothing would consume
# them; add the plumbing only together with an adopted upload step.
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/word-addin/dist ./dist
COPY --from=build /app/word-addin/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
