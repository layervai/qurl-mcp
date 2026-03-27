import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IQURLClient } from "./client.js";
import { createQurlTool, createQurlSchema } from "./tools/create-qurl.js";
import { resolveQurlTool, resolveQurlSchema } from "./tools/resolve-qurl.js";
import { listQurlsTool, listQurlsSchema } from "./tools/list-qurls.js";
import { getQurlTool, getQurlSchema } from "./tools/get-qurl.js";
import { deleteQurlTool, deleteQurlSchema } from "./tools/delete-qurl.js";
import { updateQurlTool, updateQurlBaseSchema } from "./tools/update-qurl.js";
import { mintLinkTool, mintLinkBaseSchema } from "./tools/mint-link.js";
import { batchCreateTool, batchCreateSchema } from "./tools/batch-create.js";
import { linksResource } from "./resources/links.js";
import { usageResource } from "./resources/usage.js";
import { secureAServicePrompt } from "./prompts/secure-a-service.js";
import { auditLinksPrompt } from "./prompts/audit-links.js";
import { rotateAccessPrompt } from "./prompts/rotate-access.js";

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

  const update = updateQurlTool(client);
  server.tool(update.name, update.description, updateQurlBaseSchema.shape, update.handler);

  const mint = mintLinkTool(client);
  server.tool(mint.name, mint.description, mintLinkBaseSchema.shape, mint.handler);

  const batch = batchCreateTool(client);
  server.tool(batch.name, batch.description, batchCreateSchema.shape, batch.handler);

  // Register resources — server.resource(name, uri, handler)
  const links = linksResource(client);
  server.resource(links.name, links.uri, links.handler);

  const usage = usageResource(client);
  server.resource(usage.name, usage.uri, usage.handler);

  // Register prompts
  const secure = secureAServicePrompt();
  server.prompt(secure.name, secure.description, secure.args, secure.handler);

  const audit = auditLinksPrompt();
  server.prompt(audit.name, audit.description, audit.handler);

  const rotate = rotateAccessPrompt();
  server.prompt(rotate.name, rotate.description, rotate.args, rotate.handler);

  return server;
}
