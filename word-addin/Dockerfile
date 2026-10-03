FROM node:22-slim AS build
WORKDIR /app/word-addin
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY word-addin/package.json word-addin/pnpm-lock.yaml word-addin/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY word-addin/ ./
COPY frontend/src/shared/ui/ /app/frontend/src/shared/ui/
COPY frontend/public/icons/ /app/frontend/public/icons/
ENV REACT_APP_API_BASE_URL=/ REACT_APP_WEB_APP_URL=""
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/word-addin/dist ./dist
COPY --from=build /app/word-addin/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
