import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  qurlDisplayIdSchema,
  resourceOnlyIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
} from "./_shared.js";
import { revokeQurlTokenOutputSchema } from "./output-schemas.js";

export const revokeQurlTokenSchema = z.object({
  resource_id: resourceOnlyIdSchema("revoke a specific qURL token from"),
  qurl_id: qurlDisplayIdSchema("revoke"),
});

export function revokeQurlTokenTool(client: IQURLClient) {
  return {
    name: "revoke_qurl_token",
    title: "Revoke qURL Token",
    description:
      "Revoke one qURL token under a resource without revoking the whole resource. " +
      "Use this when a single recipient/link should stop working but sibling qURLs on the same `resource_id` must remain active. " +
      "Use `delete_qurl` instead when you want to revoke the resource and every token under it. " +
      "**Constraints:** requires the parent `resource_id` (`r_…`) and the token display ID (`q_…`). Re-revoking an inactive token returns an API error rather than being treated as idempotent.",
    inputSchema: revokeQurlTokenSchema,
    outputSchema: revokeQurlTokenOutputSchema,
    annotations: {
      title: "Revoke qURL Token",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof revokeQurlTokenSchema>) => {
      await client.revokeQurlToken(input.resource_id, input.qurl_id);
      const payload = {
        resource_id: input.resource_id,
        qurl_id: input.qurl_id,
        revoked: true as const,
        message: `qURL token ${input.qurl_id} is revoked.`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: toStructuredContent(payload),
      };
    }),
  };
}
