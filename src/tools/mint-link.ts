import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { accessPolicySchema } from "./create-qurl.js";
import {
  emailDeliveryInputSchema,
  maybeDeliverToolEmail,
  toEmailAugmentedResult,
} from "./email-delivery.js";
import {
  allowsServerApiKeyFallback,
  resourceIdSchema,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { mintLinkOutputSchema } from "./output-schemas.js";

export const mintLinkBaseSchema = z.object({
  resource_id: resourceIdSchema("mint a new access link for"),
  label: z
    .string()
    .max(500)
    .optional()
    .describe("Human-readable label identifying who this link is for (max 500 chars)"),
  expires_in: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Relative duration until expiration (e.g., "5m", "24h", "7d"). Mutually exclusive with expires_at',
    ),
  expires_at: z
    .string()
    .datetime()
    .optional()
    .describe("Absolute expiration timestamp (RFC 3339). Mutually exclusive with expires_in"),
  one_time_use: z.boolean().optional().describe("Whether this link can only be used once"),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Maximum concurrent sessions for this qURL token (0 = unlimited, max 1000)"),
  session_duration: z
    .string()
    .min(1)
    .optional()
    .describe(
      'How long access lasts after clicking (e.g., "1h"). ' +
        "Rejected if it exceeds the parent resource's session-duration cap.",
    ),
  access_policy: accessPolicySchema.optional().describe("Access control policy for this link"),
  email_delivery: emailDeliveryInputSchema
    .optional()
    .describe(
      "Optional email notification settings for sending the minted access link to one or more recipients.",
    ),
});

export const mintLinkSchema = mintLinkBaseSchema.refine(
  (data) => !(data.expires_in && data.expires_at),
  { message: "Provide either expires_in or expires_at, not both" },
);

export function mintLinkTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  return {
    name: "mint_link",
    title: "Mint Access Link",
    description:
      "Mint a fresh access link for an existing qURL resource — same one-shot display semantics as `create_qurl.qurl_link`. " +
      "Use this to issue additional access links to a resource without creating a brand-new qURL (e.g. a second recipient, a replacement after the original was lost). " +
      "Use `create_qurl` instead when you want a brand-new resource with its own target_url and policy. " +
      "Use `update_qurl` when you only want to change expiration/tags/description on the existing resource. " +
      "Accepts both `r_` and `q_` IDs. " +
      "**Constraints:** `expires_in` and `expires_at` are mutually exclusive (handler returns an `isError: true` content block before any API call if both are set). " +
      "If neither expiry field is specified, the API defaults to 24 hours from now. " +
      "**Output:** the new `qurl_link` is shown ONCE — no subsequent call returns it. Capture `qurl_id` if you need to correlate future access events or update this specific token.",
    inputSchema: mintLinkBaseSchema,
    outputSchema: mintLinkOutputSchema,
    annotations: {
      title: "Mint Access Link",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof mintLinkBaseSchema>) => {
      const parsed = mintLinkSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const { resource_id, email_delivery, ...body } = parsed.data;
      const result = await client.mintLink(resource_id, body);
      const emailResult = await maybeDeliverToolEmail({
        allowServerApiKeyFallback: allowsServerApiKeyFallback(runtime),
        delivery: email_delivery,
        defaultSubject: "Your qURL access link is ready",
        detailLines: [
          "A new qURL access link has been minted for you.",
          `Resource ID: ${resource_id}`,
          `Secure Link: ${result.data.qurl_link}`,
          `Expires At: ${result.data.expires_at}`,
          ...(body.label ? [`Label: ${body.label}`] : []),
          ...(result.data.type ? [`Type: ${result.data.type}`] : []),
        ],
      });
      return toEmailAugmentedResult(result.data, emailResult);
    }),
  };
}
