import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  qurlDisplayIdSchema,
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { extendQurlOutputSchema } from "./output-schemas.js";

export const extendQurlSchema = z.object({
  resource_id: resourceIdSchema("extend"),
  extend_by: z.string().min(1).describe('Duration to extend by (e.g., "24h", "7d")'),
  qurl_id: qurlDisplayIdSchema("extend")
    .optional()
    .describe(
      "The link (q_ display ID) to extend. Required when the resource has more than one active link.",
    ),
});

// A link's lifetime is its access token's `expires_at`; the resource's own
// expiry is a far-future ceiling, so extending the resource never kept a link
// open longer (qurl-mcp#279). Resolve which link the caller means. The token
// route needs the parent resource ID, which only a read resolves from a q_ ID.
async function linkToExtend(
  client: IQURLClient,
  input: z.infer<typeof extendQurlSchema>,
): Promise<{ resourceId: string; qurlId: string }> {
  const { data: resource } = await client.getQURL(input.resource_id);
  const named =
    input.qurl_id ?? (input.resource_id.startsWith("q_") ? input.resource_id : undefined);
  if (named) return { resourceId: resource.resource_id, qurlId: named };
  const active = (resource.qurls ?? []).filter((link) => link.status === "active");
  if (active.length === 1) return { resourceId: resource.resource_id, qurlId: active[0].qurl_id };
  throw new Error(
    active.length === 0
      ? "This resource has no active link to extend. Use mint_link to issue a new one."
      : `This resource has ${active.length} active links (${active.map((link) => link.qurl_id).join(", ")}); pass qurl_id to choose which one to extend.`,
  );
}

export function extendQurlTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "extend_qurl",
    title: "Extend qURL Expiration",
    description:
      "Keep a qURL link open longer by pushing out the link's expiration by a relative duration. " +
      "Pass a link's `q_` display ID as `resource_id`, or a resource ID plus `qurl_id`; a resource with exactly one active link needs no `qurl_id`. " +
      "Use this when the only change you need is more time on the clock. " +
      "Use `update_qurl_token` instead to set an absolute `expires_at` or change the link's label, policy, or sessions. " +
      "Use `revoke_qurl_token` or `delete_qurl` when you want to cut off access. " +
      "**Not idempotent:** calling twice with the same `extend_by` extends the link twice; use `update_qurl_token` with `expires_at` when retries must not double-push. " +
      "Returns the resource (same shape as `get_qurl`); the extended link's new expiry is in `qurls[].expires_at`, not the resource's own `expires_at`.",
    inputSchema: extendQurlSchema,
    outputSchema: extendQurlOutputSchema,
    annotations: {
      title: "Extend qURL Expiration",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof extendQurlSchema>) => {
      const { resourceId, qurlId } = await linkToExtend(client, input);
      await client.updateQurlToken(resourceId, qurlId, { extend_by: input.extend_by });
      const result = await client.getQURL(resourceId);
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
