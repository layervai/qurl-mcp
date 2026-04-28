import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
} from "./_shared.js";
import { updateQurlOutputSchema } from "./output-schemas.js";

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
    title: "Update qURL",
    description:
      "Update a qURL's expiration, tags, or description. The richer alternative to `extend_qurl` — use `update_qurl` whenever you need anything beyond a relative time push. " +
      "Accepts both `r_` and `q_` IDs (q_ is auto-resolved). " +
      "**Constraints:** `extend_by` and `expires_at` are mutually exclusive; at least one update field (`extend_by`, `expires_at`, `tags`, `description`) must be set. " +
      "**Clearing fields:** pass `description: \"\"` or `tags: []` to clear those fields explicitly. " +
      "Use `extend_qurl` when the only change is a relative time push. " +
      "Use `delete_qurl` when you want to revoke entirely. " +
      "**Errors:** if the input fails schema refinements (both extend_by + expires_at, or no fields set), the handler returns an `isError: true` content block before any API call. Other API errors throw with the API's `code`/`statusCode`. " +
      "Returns the updated resource (same shape as `get_qurl`).",
    // Base shape for MCP tool registration; refinements run in the handler
    inputSchema: updateQurlBaseSchema,
    outputSchema: updateQurlOutputSchema,
    annotations: {
      title: "Update qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
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
        structuredContent: toStructuredContent(result.data),
      };
    }),
  };
}
