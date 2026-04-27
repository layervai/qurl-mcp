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
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# Placeholder so the server boots for MCP introspection (tools/list, resources/list,
# prompts/list). Real deployments must override at runtime:
#   docker run -e QURL_API_KEY=lv_live_xxx ghcr.io/layervai/qurl-mcp
ENV QURL_API_KEY=replace_with_real_key

ENTRYPOINT ["node", "dist/index.js"]
