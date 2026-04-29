# @layervai/qurl-mcp

[![npm version](https://img.shields.io/npm/v/@layervai/qurl-mcp.svg)](https://www.npmjs.com/package/@layervai/qurl-mcp)

> **⚠️ Renamed from `@layerv/qurl-mcp` in v0.4.0.** The old package is deprecated and will not receive further updates. If you're using `@layerv/qurl-mcp@0.3.x`, swap the scope in your MCP client config — same binary, same API key, no other changes.

MCP server for qURL™ secure link management.

> **Quantum URL (qURL)** · The internet has a hidden layer. This is how you enter.

## What it does

qURL MCP Server is a [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI agents (Claude, GPT, Cursor, etc.) create, resolve, list, and manage qURL secure links natively. It connects to the qURL API over stdio transport, so any MCP-compatible client can use it without custom integration code.

## Quick Start

Add the server to your MCP client configuration (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "qurl": {
      "command": "npx",
      "args": ["@layervai/qurl-mcp"],
      "env": { "QURL_API_KEY": "lv_live_xxx" }
    }
  }
}
```

Replace `lv_live_xxx` with your actual API key. The key must have the appropriate scopes for the tools you intend to use (see below).

## Available Tools

| Tool | Description | Required Scope |
|------|-------------|----------------|
| `create_qurl` | Create a secure, policy-bound link to a protected resource | `qurl:write` |
| `resolve_qurl` | Resolve an access token to get the target URL and open firewall access | `qurl:resolve` |
| `list_qurls` | List active qURLs with optional pagination | `qurl:read` |
| `get_qurl` | Get details of a specific qURL by resource ID | `qurl:read` |
| `delete_qurl` | Revoke a qURL, immediately invalidating the link | `qurl:write` |
| `extend_qurl` | Extend the expiration of an active qURL (alias for `update_qurl`) | `qurl:write` |
| `update_qurl` | Update expiration, tags, or description on an active qURL | `qurl:write` |
| `mint_link` | Mint a new access link for an existing protected resource | `qurl:write` |
| `batch_create_qurls` | Create multiple qURLs in a single call | `qurl:write` |

## Available Resources

| URI | Name | Description |
|-----|------|-------------|
| `qurl://links` | Active qURL Links | List of all active qURL links |
| `qurl://usage` | qURL Usage & Quota | Current quota and usage information |

## Configuration

| Environment Variable | Required | Description | Default |
|---------------------|----------|-------------|---------|
| `QURL_API_KEY` | Conditional (see description) | API key with appropriate scopes (`qurl:read`, `qurl:write`, `qurl:resolve`). The server boots without it so MCP introspection (`tools/list`, `resources/list`, `prompts/list`) works for directory probes — required only on the first tool call or resource read, where invocations surface a typed `missing_api_key` error until the key is set. | -- |
| `QURL_API_URL` | No | qURL API base URL | `https://api.layerv.ai` |

## Docker

A multi-stage Dockerfile is included for container-based deployment:

```bash
docker build -t qurl-mcp .
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp
```

The image runs as the non-root `node` user, ships only production dependencies, and uses `tini` as PID 1 for clean signal handling.

If a tool call returns `missing_api_key` despite `QURL_API_KEY` looking set, check stderr for the boot-time warning — some MCP hosts hide stderr, and the warning is the fastest way to spot a whitespace-only or unset value:

```bash
docker logs <container>          # if running detached
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp 2>&1  # interactive
```

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Additional commands:

```bash
npm run dev          # Watch mode (rebuild on changes)
npm run format       # Format source with Prettier
npm run format:check # Check formatting without modifying files
```

## License

MIT -- [LayerV AI](https://layerv.ai)
