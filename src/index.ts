#!/usr/bin/env node

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QURLClient } from "./client.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const apiKey = process.env.QURL_API_KEY;
if (!apiKey) {
  console.error("Error: QURL_API_KEY environment variable is required");
  process.exit(1);
}

const baseURL = process.env.QURL_API_URL ?? "https://api.layerv.ai";

const client = new QURLClient({ apiKey, baseURL });
const server = createServer(client, version);

const transport = new StdioServerTransport();
await server.connect(transport);
