#!/usr/bin/env node

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QURLClient } from "./client.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Auth validation is deferred to first API call so the server can boot for
// MCP introspection (tools/list, resources/list, prompts/list) without a key.
// Tool/resource invocations that hit the API will throw a clear error if the
// key is missing.
const apiKey = process.env.QURL_API_KEY ?? "";
if (!apiKey) {
  console.error(
    "Warning: QURL_API_KEY is not set. MCP introspection will succeed, but every tool/resource invocation will fail until you set it.",
  );
}

const baseURL = process.env.QURL_API_URL ?? "https://api.layerv.ai";

const client = new QURLClient({ apiKey, baseURL });
const server = createServer(client, version);

const transport = new StdioServerTransport();
await server.connect(transport);
