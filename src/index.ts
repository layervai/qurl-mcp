#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QURLClient } from "./client.js";
import { createQurlTool, createQurlSchema } from "./tools/create-qurl.js";
import { resolveQurlTool, resolveQurlSchema } from "./tools/resolve-qurl.js";
import { listQurlsTool, listQurlsSchema } from "./tools/list-qurls.js";
import { getQurlTool, getQurlSchema } from "./tools/get-qurl.js";
import { deleteQurlTool, deleteQurlSchema } from "./tools/delete-qurl.js";
import { extendQurlTool, extendQurlSchema } from "./tools/extend-qurl.js";
import { linksResource } from "./resources/links.js";
import { usageResource } from "./resources/usage.js";

const apiKey = process.env.QURL_API_KEY;
if (!apiKey) {
  console.error("Error: QURL_API_KEY environment variable is required");
  process.exit(1);
}

const baseURL = process.env.QURL_API_URL ?? "https://api.layerv.ai";

const client = new QURLClient({ apiKey, baseURL });

const server = new McpServer({
  name: "qurl",
  version: "0.1.0",
});

// Register tools
const create = createQurlTool(client);
server.tool(create.name, create.description, createQurlSchema.shape, async (params) => {
  return create.handler(params);
});

const resolve = resolveQurlTool(client);
server.tool(resolve.name, resolve.description, resolveQurlSchema.shape, async (params) => {
  return resolve.handler(params);
});

const list = listQurlsTool(client);
server.tool(list.name, list.description, listQurlsSchema.shape, async (params) => {
  return list.handler(params);
});

const get = getQurlTool(client);
server.tool(get.name, get.description, getQurlSchema.shape, async (params) => {
  return get.handler(params);
});

const del = deleteQurlTool(client);
server.tool(del.name, del.description, deleteQurlSchema.shape, async (params) => {
  return del.handler(params);
});

const extend = extendQurlTool(client);
server.tool(extend.name, extend.description, extendQurlSchema.shape, async (params) => {
  return extend.handler(params);
});

// Register resources
const links = linksResource(client);
server.resource(links.uri, links.name, async () => {
  return links.handler();
});

const usage = usageResource(client);
server.resource(usage.uri, usage.name, async () => {
  return usage.handler();
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
