import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { accessPolicySchema } from "./create-qurl.js";
import {
  durationSchema,
  MAX_EXPIRY_MS,
  MAX_SESSION_MS,
  MIN_EXPIRY_MS,
  MIN_SESSION_MS,
} from "./duration.js";
import {
  qurlDisplayIdSchema,
  resourceOnlyIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { updateQurlTokenOutputSchema } from "./output-schemas.js";

export const updateQurlTokenBaseSchema = z.object({
  resource_id: resourceOnlyIdSchema("update a specific qURL token under"),
  qurl_id: qurlDisplayIdSchema("update"),
  extend_by: durationSchema(MIN_EXPIRY_MS, MAX_EXPIRY_MS, "1m to 30d")
    .optional()
    .describe(
      'Duration to extend this token by (e.g., "24h", "7d"). Mutually exclusive with expires_at.',
    ),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("Absolute token expiration timestamp (RFC 3339). Mutually exclusive with extend_by."),
  label: z.string().max(500).optional().describe("Human-readable label for this token"),
  access_policy: accessPolicySchema.optional().describe("Replace the access policy for this token"),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Maximum concurrent sessions for this token (0 = unlimited, max 1000)"),
  // "" keeps its meaning (apply the parent resource cap); anything else is a bounded duration.
  session_duration: z
    .union([z.literal(""), durationSchema(MIN_SESSION_MS, MAX_SESSION_MS, "1s to 24h")])
    .optional()
    .describe(
      'How long access lasts after clicking (e.g., "1h"). Empty string applies the parent resource cap when one is set.',
    ),
});

export const updateQurlTokenSchema = updateQurlTokenBaseSchema
  .refine((data) => !(data.extend_by && data.expires_at), {
    message: "Provide either extend_by or expires_at, not both",
  })
  .refine(
    (data) =>
      data.extend_by !== undefined ||
      data.expires_at !== undefined ||
      data.label !== undefined ||
      data.access_policy !== undefined ||
      data.max_sessions !== undefined ||
      data.session_duration !== undefined,
    {
      message:
        "At least one update field (extend_by, expires_at, label, access_policy, max_sessions, or session_duration) is required",
    },
  );

export function updateQurlTokenTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "update_qurl_token",
    title: "Update qURL Token",
    description:
      "Update one qURL token under a resource: expiration, label, access policy, max sessions, or session duration. " +
      "Use this when you need to change a specific `q_…` token without changing sibling tokens or resource-level metadata. " +
      "Use `update_qurl` instead for resource-level description/tags/custom-domain changes, and use `revoke_qurl_token` when the token should stop working entirely. " +
      "**Constraints:** `extend_by` and `expires_at` are mutually exclusive; at least one token update field must be set. " +
      "Returns the updated token summary.",
    inputSchema: updateQurlTokenBaseSchema,
    outputSchema: updateQurlTokenOutputSchema,
    annotations: {
      title: "Update qURL Token",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof updateQurlTokenBaseSchema>) => {
      const parsed = updateQurlTokenSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const { resource_id, qurl_id, ...body } = parsed.data;
      const result = await client.updateQurlToken(resource_id, qurl_id, body);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
        structuredContent: toStructuredContent(result.data),
      };
    }),
  };
}
