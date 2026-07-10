import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { getQurlOutputSchema } from "./output-schemas.js";

export const getQurlSchema = z.object({
  resource_id: resourceIdSchema("fetch"),
});

export function getQurlTool(client: IQURLClient, _runtime: ToolRuntimeOptions = { mode: "stdio" }) {
  return {
    name: "get_qurl",
    title: "Get qURL",
    description:
      "Fetch a single qURL resource by ID and return its current state plus a bounded preview of access tokens. " +
      "Use this when you have a specific resource ID (r_ prefix) or qURL display ID (q_ prefix) — q_ IDs are auto-resolved to their parent resource. " +
      "Do not use this to create a new qURL for a freshly uploaded image, PDF, screenshot, or file attachment. For chat-uploaded file content in HTTP MCP mode, use `upload_file_data_qurl` instead. " +
      "Use `list_qurls` instead when you need to discover qURLs by status, date range, or search query. " +
      "Use `resolve_qurl` instead when you have an end-user access token (at_ prefix) and need to redeem it for the underlying URL. " +
      "If the user asks for 'the qURL of this image/file', this tool is only correct when you already know the existing `resource_id` or `qurl_id`. " +
      "`qurls[]` is an unordered preview capped by the API at 100 rows and may be omitted on list views, preview lookup failure, or redacted connector-owned resources; use `qurl_count` to detect that more token rows may exist. " +
      "The one-shot `qurl_link` from creation is never returned here.",
    inputSchema: getQurlSchema,
    outputSchema: getQurlOutputSchema,
    annotations: {
      title: "Get qURL",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof getQurlSchema>) => {
      const result = await client.getQURL(input.resource_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
        structuredContent: toStructuredContent(result.data),
      };
    }),
  };
}
