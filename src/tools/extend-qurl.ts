import { z } from "zod";
import { QURLAPIError, type IQURLClient } from "../client.js";
import { formatErrorForLog } from "../logging.js";
import { parseDurationMs } from "./upload-mint-options.js";
import {
  isQurlDisplayId,
  qurlDisplayIdSchema,
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { extendQurlOutputSchema } from "./output-schemas.js";

export const extendQurlSchema = z.object({
  resource_id: resourceIdSchema("extend"),
  extend_by: z
    .string()
    .min(1)
    .refine((value) => (parseDurationMs(value) ?? 0) > 0, {
      message: "Use a positive duration like '30m', '24h', '7d', or '1w'",
    })
    .describe('Duration to extend by (e.g., "24h", "7d")'),
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
): Promise<{ resourceId: string; qurlId: string } | { error: string }> {
  const resourceIsLink = isQurlDisplayId(input.resource_id);
  if (resourceIsLink && input.qurl_id && input.qurl_id !== input.resource_id) {
    return {
      error: `resource_id names link ${input.resource_id} but qurl_id names ${input.qurl_id}; pass one link.`,
    };
  }
  if (input.qurl_id && !resourceIsLink) {
    return { resourceId: input.resource_id, qurlId: input.qurl_id };
  }
  let resource: Awaited<ReturnType<IQURLClient["getQURL"]>>["data"];
  try {
    resource = (await client.getQURL(input.resource_id)).data;
  } catch (error) {
    // The shared wrapper turns a missing key into its own guidance.
    if (error instanceof QURLAPIError && error.code === "missing_api_key") throw error;
    return {
      error:
        `Reading the resource to pick a link failed (${error instanceof Error ? error.message : "unknown error"}; ` +
        "the resource may not exist, or the API key may lack qurl:read). Pass qurl_id with a resource ID to extend a specific link without a read.",
    };
  }
  const named = resourceIsLink ? input.resource_id : undefined;
  if (named) return { resourceId: resource.resource_id, qurlId: named };
  if (!resource.qurls) {
    return { error: "The resource read did not include its links; pass qurl_id to choose one." };
  }
  const active = resource.qurls.filter((link) => link.status === "active");
  if (active.length === 1) return { resourceId: resource.resource_id, qurlId: active[0].qurl_id };
  if (active.length === 0) {
    return {
      error: "This resource has no active link to extend. Use mint_link to issue a new one.",
    };
  }
  const shown = active.slice(0, 10).map((link) => link.qurl_id);
  const more = active.length > shown.length ? ` and ${active.length - shown.length} more` : "";
  return {
    error: `This resource has ${active.length} active links (${shown.join(", ")}${more}); pass qurl_id to choose which one to extend.`,
  };
}

const errorResult = (text: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text }],
});

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
      "Requires `qurl:write` and `qurl:read` (it reads the resource to pick the link and to return it). " +
      "A link cannot outlive its resource: if the resource's own `expires_at` is sooner, raise it with `update_qurl` first. " +
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
      const target = await linkToExtend(client, input);
      if ("error" in target) return errorResult(target.error);
      const { resourceId, qurlId } = target;
      const token = await client.updateQurlToken(resourceId, qurlId, {
        extend_by: input.extend_by,
      });
      let result: Awaited<ReturnType<IQURLClient["getQURL"]>>;
      try {
        result = await client.getQURL(resourceId);
      } catch (error) {
        // The extension already happened; a retry would push the link out twice.
        console.error(
          `extend_qurl extended ${qurlId} but reading the resource failed (${formatErrorForLog(error)})`,
        );
        return errorResult(
          `Link ${qurlId} was extended; it now expires at ${token.data.expires_at ?? "the new time"}. ` +
            "Do not retry. Reading the updated resource failed (the API key may lack qurl:read).",
        );
      }
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
