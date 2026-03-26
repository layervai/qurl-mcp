import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const updateQurlBaseSchema = z.object({
  resource_id: z.string().describe("The resource ID to update"),
  extend_by: z.string().optional().describe('Duration to extend by (e.g., "24h", "7d"). Mutually exclusive with expires_at.'),
  expires_at: z.string().datetime().optional().describe("Absolute expiration timestamp (RFC 3339). Mutually exclusive with extend_by."),
  tags: z.array(z.string()).optional().describe("Replace all tags on this resource"),
  description: z.string().optional().describe("Replace the resource description"),
});

export const updateQurlSchema = updateQurlBaseSchema
  .refine((data) => !(data.extend_by && data.expires_at), {
    message: "Provide either extend_by or expires_at, not both",
  })
  .refine((data) => data.extend_by || data.expires_at || data.tags || data.description, {
    message: "At least one update field (extend_by, expires_at, tags, or description) is required",
  });

export function updateQurlTool(client: IQURLClient) {
  return {
    name: "update_qurl",
    description:
      "Update a QURL - extend expiration, set an absolute expiry, update tags, or change the description. " +
      "Do not provide both extend_by and expires_at.",
    // Base shape for MCP tool registration; refinements run in the handler
    inputSchema: updateQurlBaseSchema,
    handler: async (raw: z.infer<typeof updateQurlBaseSchema>) => {
      const input = updateQurlSchema.parse(raw);
      const { resource_id, ...body } = input;
      const result = await client.updateQURL(resource_id, body);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
      };
    },
  };
}
