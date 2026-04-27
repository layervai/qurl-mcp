#!/usr/bin/env node

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MISSING_API_KEY_MESSAGE, QURLClient } from "./client.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Auth validation is deferred to first API call so the server can boot for
// MCP introspection (tools/list, resources/list, prompts/list) without a key.
// Tool/resource invocations that hit the API will throw the same typed error
// from `QURLClient.request()` if the key is missing.
//
// Trim so whitespace-only values (e.g. `QURL_API_KEY=" "`) take the same
// missing-key path as truly unset; otherwise they'd silently pass the guard
// and surface as a 401 from the server.
const apiKey = process.env.QURL_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error(`Warning: ${MISSING_API_KEY_MESSAGE}`);
}

const baseURL = process.env.QURL_API_URL ?? "https://api.layerv.ai";

const client = new QURLClient({ apiKey, baseURL });
const server = createServer(client, version);

const transport = new StdioServerTransport();
await server.connect(transport);
