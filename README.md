# @layerv/qurl-mcp

[![npm version](https://img.shields.io/npm/v/@layerv/qurl-mcp.svg)](https://www.npmjs.com/package/@layerv/qurl-mcp)

MCP server for QURL secure link management.

## What it does

QURL MCP Server is a [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI agents (Claude, GPT, Cursor, etc.) create, resolve, list, and manage QURL secure links natively. It connects to the QURL API over stdio transport, so any MCP-compatible client can use it without custom integration code.

## Quick Start

Add the server to your MCP client configuration (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "qurl": {
      "command": "npx",
      "args": ["@layerv/qurl-mcp"],
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
| `list_qurls` | List active QURLs with optional pagination | `qurl:read` |
| `get_qurl` | Get details of a specific QURL by resource ID | `qurl:read` |
| `delete_qurl` | Revoke a QURL, immediately invalidating the link | `qurl:write` |
| `extend_qurl` | Extend the expiration of an active QURL | `qurl:write` |

## Available Resources

| URI | Name | Description |
|-----|------|-------------|
| `qurl://links` | Active QURL Links | List of all active QURL links |
| `qurl://usage` | QURL Usage & Quota | Current quota and usage information |

## Configuration

| Environment Variable | Required | Description | Default |
|---------------------|----------|-------------|---------|
| `QURL_API_KEY` | Yes | API key with appropriate scopes (`qurl:read`, `qurl:write`, `qurl:resolve`) | -- |
| `QURL_API_URL` | No | QURL API base URL | `https://api.layerv.ai` |

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
