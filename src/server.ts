import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { IQURLClient } from "./client.js";
import { createQurlTool } from "./tools/create-qurl.js";
import { resolveQurlTool } from "./tools/resolve-qurl.js";
import { listQurlsTool } from "./tools/list-qurls.js";
import { getQurlTool } from "./tools/get-qurl.js";
import { deleteQurlTool } from "./tools/delete-qurl.js";
import { extendQurlTool } from "./tools/extend-qurl.js";
import { updateQurlTool } from "./tools/update-qurl.js";
import { mintLinkTool } from "./tools/mint-link.js";
import { batchCreateTool } from "./tools/batch-create.js";
import type { ToolAnnotations } from "./tools/_shared.js";
import { linksResource } from "./resources/links.js";
import { usageResource } from "./resources/usage.js";
import { secureAServicePrompt } from "./prompts/secure-a-service.js";
import { auditLinksPrompt } from "./prompts/audit-links.js";
import { rotateAccessPrompt } from "./prompts/rotate-access.js";

/**
 * Shape of the object every tool factory returns. Exported so the
 * TDQS-coverage test can iterate the same canonical list without
 * redeclaring the type.
 */
export type ToolFactory = (client: IQURLClient) => {
  name: string;
  title: string;
  description: string;
  inputSchema: z.AnyZodObject;
  outputSchema: z.AnyZodObject;
  annotations: ToolAnnotations;
  // Args vary per tool; exact signatures are validated by registerTool at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
};

export const toolFactories = [
  createQurlTool,
  resolveQurlTool,
  listQurlsTool,
  getQurlTool,
  deleteQurlTool,
  extendQurlTool,
  updateQurlTool,
  mintLinkTool,
  batchCreateTool,
] satisfies ToolFactory[];

export function createServer(client: IQURLClient, version: string): McpServer {
  const server = new McpServer({
    name: "qurl",
    version,
  });

  for (const factory of toolFactories) {
    const tool = factory(client);
    // registerTool wires outputSchema + annotations into tools/list; pass
    // .shape (ZodRawShape), not the ZodObject itself.
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        outputSchema: tool.outputSchema.shape,
        annotations: tool.annotations,
      },
      tool.handler,
    );
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
