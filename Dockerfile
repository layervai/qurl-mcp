# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
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
