FROM node:22-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ARG REACT_APP_WEB_APP_URL
ARG WORD_ADDIN_PUBLIC_URL
ENV REACT_APP_API_BASE_URL=/api \
    REACT_APP_WEB_APP_URL=$REACT_APP_WEB_APP_URL \
    WORD_ADDIN_PUBLIC_URL=$WORD_ADDIN_PUBLIC_URL
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
