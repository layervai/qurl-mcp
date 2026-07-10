# syntax=docker/dockerfile:1.7

# Base image pinned by digest (Renovate/Dependabot will keep it current).
# Floating tags would shift between builds and reopen a supply-chain seam the
# rest of this workflow's SHA-pinned actions are designed to close.
FROM node:26-alpine@sha256:725aeba2364a9b16beae49e180d83bd597dbd0b15c47f1f28875c290bfd255b9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY assets ./assets
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-alpine@sha256:725aeba2364a9b16beae49e180d83bd597dbd0b15c47f1f28875c290bfd255b9
LABEL org.opencontainers.image.source="https://github.com/layervai/qurl-mcp" \
      org.opencontainers.image.description="MCP server for qURL — secure expiring access links for AI agents." \
      org.opencontainers.image.licenses="MIT AND OFL-1.1"

# tini reaps zombies and forwards SIGTERM to node so `docker stop`
# triggers a graceful shutdown instead of relying on Node's default
# PID-1 signal handling. Alternative is `docker run --init …`, but
# baking it in keeps the image self-contained.
RUN apk add --no-cache tini

WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node --from=build /app/package.json ./

ENV NODE_ENV=production
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
