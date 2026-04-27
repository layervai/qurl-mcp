import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { resourceIdSchema, withMissingApiKeyHandler, zodErrorToToolResult } from "./_shared.js";

// Tags must match the API constraints: 1-50 chars, start with alphanumeric,
// allow alphanumerics/spaces/underscores/hyphens. Max 10 tags per resource.
// See qurl/api/openapi.yaml -> UpdateQurlRequest.tags.
const tagSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
    "Tag must start with alphanumeric and contain only letters, numbers, spaces, underscores, or hyphens",
  );

export const updateQurlBaseSchema = z.object({
  resource_id: resourceIdSchema("update"),
  extend_by: z.string().min(1).optional().describe('Duration to extend by (e.g., "24h", "7d"). Mutually exclusive with expires_at.'),
  expires_at: z.string().datetime().optional().describe("Absolute expiration timestamp (RFC 3339). Mutually exclusive with extend_by."),
  tags: z
    .array(tagSchema)
    .max(10)
    .optional()
    .describe("Replace all tags on this resource (max 10 tags, each 1-50 chars)"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Replace the resource description (max 500 chars)"),
});

export const updateQurlSchema = updateQurlBaseSchema
  .refine((data) => !(data.extend_by && data.expires_at), {
    message: "Provide either extend_by or expires_at, not both",
  })
  .refine(
    // Use `!== undefined` rather than truthy checks so the API's "clear"
    // semantics work: the spec documents `description: ""` and `tags: []`
    // as valid payloads that clear the field. A plain `||` would reject
    // both because empty string is falsy in JS.
    (data) =>
      data.extend_by !== undefined ||
      data.expires_at !== undefined ||
      data.tags !== undefined ||
      data.description !== undefined,
    {
      message:
        "At least one update field (extend_by, expires_at, tags, or description) is required",
    },
  );

export function updateQurlTool(client: IQURLClient) {
  return {
    name: "update_qurl",
    description:
      "Update a qURL - extend expiration, set an absolute expiry, update tags, or change the description. " +
      "Accepts either a resource ID (r_ prefix) or qURL display ID (q_ prefix). " +
      "Do not provide both extend_by and expires_at. At least one update field is required.",
    // Base shape for MCP tool registration; refinements run in the handler
    inputSchema: updateQurlBaseSchema,
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof updateQurlBaseSchema>) => {
      const parsed = updateQurlSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const { resource_id, ...body } = parsed.data;
      const result = await client.updateQURL(resource_id, body);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
      };
    }),
  };
}
