import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { IQURLClient } from "./client.js";
import { createQurlTool } from "./tools/create-qurl.js";
import { resolveQurlTool } from "./tools/resolve-qurl.js";
import { listQurlsTool } from "./tools/list-qurls.js";
import { getQurlTool } from "./tools/get-qurl.js";
import { deleteQurlTool } from "./tools/delete-qurl.js";
import { extendQurlTool } from "./tools/extend-qurl.js";
import { linksResource } from "./resources/links.js";
import { usageResource } from "./resources/usage.js";
import { secureAServicePrompt } from "./prompts/secure-a-service.js";
import { auditLinksPrompt } from "./prompts/audit-links.js";
import { rotateAccessPrompt } from "./prompts/rotate-access.js";

/** Shared contract for the objects returned by tool factory functions. */
type ToolFactory = (client: IQURLClient) => {
  name: string;
  description: string;
  inputSchema: z.AnyZodObject;
  handler: unknown;
};

export function createServer(client: IQURLClient, version: string): McpServer {
  const server = new McpServer({
    name: "qurl",
    version,
  });

  // Register tools
  const toolFactories = [
    createQurlTool,
    resolveQurlTool,
    listQurlsTool,
    getQurlTool,
    deleteQurlTool,
    extendQurlTool,
  ] satisfies ToolFactory[];

  for (const factory of toolFactories) {
    const tool = factory(client);
    server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.handler);
  }

  // Register resources
  for (const factory of [linksResource, usageResource]) {
    const resource = factory(client);
    server.resource(resource.name, resource.uri, resource.handler);
  }

  // Register prompts
  const secure = secureAServicePrompt();
  server.prompt(secure.name, secure.description, secure.args, secure.handler);

  const audit = auditLinksPrompt();
  server.prompt(audit.name, audit.description, audit.handler);

  const rotate = rotateAccessPrompt();
  server.prompt(rotate.name, rotate.description, rotate.args, rotate.handler);

  return server;
}
