import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IQURLClient } from "./client.js";
import { createQurlTool, createQurlSchema } from "./tools/create-qurl.js";
import { resolveQurlTool, resolveQurlSchema } from "./tools/resolve-qurl.js";
import { listQurlsTool, listQurlsSchema } from "./tools/list-qurls.js";
import { getQurlTool, getQurlSchema } from "./tools/get-qurl.js";
import { deleteQurlTool, deleteQurlSchema } from "./tools/delete-qurl.js";
import { extendQurlTool, extendQurlSchema } from "./tools/extend-qurl.js";
import { linksResource } from "./resources/links.js";
import { usageResource } from "./resources/usage.js";

export function createServer(client: IQURLClient, version: string): McpServer {
  const server = new McpServer({
    name: "qurl",
    version,
  });

  // Register tools
  const create = createQurlTool(client);
  server.tool(create.name, create.description, createQurlSchema.shape, create.handler);

  const resolve = resolveQurlTool(client);
  server.tool(resolve.name, resolve.description, resolveQurlSchema.shape, resolve.handler);

  const list = listQurlsTool(client);
  server.tool(list.name, list.description, listQurlsSchema.shape, list.handler);

  const get = getQurlTool(client);
  server.tool(get.name, get.description, getQurlSchema.shape, get.handler);

  const del = deleteQurlTool(client);
  server.tool(del.name, del.description, deleteQurlSchema.shape, del.handler);

  const extend = extendQurlTool(client);
  server.tool(extend.name, extend.description, extendQurlSchema.shape, extend.handler);

  // Register resources — server.resource(name, uri, handler)
  const links = linksResource(client);
  server.resource(links.name, links.uri, links.handler);

  const usage = usageResource(client);
  server.resource(usage.name, usage.uri, usage.handler);

  return server;
}
