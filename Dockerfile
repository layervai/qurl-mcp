# syntax=docker/dockerfile:1.7

# Base image pinned by digest (Renovate/Dependabot will keep it current).
# Floating tags would shift between builds and reopen a supply-chain seam the
# rest of this workflow's SHA-pinned actions are designed to close.
FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-alpine@sha256:3ad34ca6292aec4a91d8ddeb9229e29d9c2f689efd0dd242860889ac71842eba
LABEL org.opencontainers.image.source="https://github.com/layervai/qurl-mcp" \
      org.opencontainers.image.description="MCP server for qURL — secure expiring access links for AI agents." \
      org.opencontainers.image.licenses="MIT"

# tini reaps zombies and forwards SIGTERM to node so `docker stop`
# triggers a graceful shutdown instead of relying on Node's default
# PID-1 signal handling. Alternative is `docker run --init …`, but
# baking it in keeps the image self-contained.
RUN apk add --no-cache tini

WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./

ENV NODE_ENV=production
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
