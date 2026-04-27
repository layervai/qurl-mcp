# syntax=docker/dockerfile:1.7

# node:22-alpine pinned by digest (Renovate/Dependabot will keep it current).
# Floating tags would shift between builds and reopen a supply-chain seam the
# rest of this workflow's SHA-pinned actions are designed to close.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
LABEL org.opencontainers.image.source="https://github.com/layervai/qurl-mcp" \
      org.opencontainers.image.description="MCP server for qURL — secure expiring access links for AI agents." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./

ENV NODE_ENV=production
USER node

ENTRYPOINT ["node", "dist/index.js"]
