import { z } from "zod";
import { QURLAPIError, type IQURLClient } from "../client.js";
import { formatErrorForLog } from "../logging.js";
import { durationSchema, MAX_EXPIRY_MS, MIN_EXPIRY_MS } from "./duration.js";
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
  resource_id: resourceIdSchema("extend").describe(
    "Resource ID, or a link's q_ display ID; a q_ ID selects that link, and this server reads the resource to find its parent",
  ),
  extend_by: durationSchema(MIN_EXPIRY_MS, MAX_EXPIRY_MS, "1m to 30d").describe(
    'Duration to extend the link by (e.g., "24h", "7d"; 1m to 30d per call)',
  ),
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
// A missing or unrecognized status is a candidate on both the named and the
// auto-selected path: token status is optional in the API and can drift. Only a
// known inactive status excludes a link.
const INACTIVE_LINK_STATUSES = new Set(["consumed", "expired", "revoked"]);

type Resource = Awaited<ReturnType<IQURLClient["getQURL"]>>["data"];

async function linkToExtend(
  client: IQURLClient,
  input: z.infer<typeof extendQurlSchema>,
): Promise<{ resourceId: string; qurlId: string; resource?: Resource } | { error: string }> {
  const resourceIsLink = isQurlDisplayId(input.resource_id);
  if (resourceIsLink && input.qurl_id && input.qurl_id !== input.resource_id) {
    return {
      error: `resource_id names link ${input.resource_id} but qurl_id names ${input.qurl_id}; pass one link.`,
    };
  }
  // Fast path: the caller named the link and its resource, so skip the read.
  // Without it there is no status check here; the token route rejects a link
  // that is no longer active.
  if (input.qurl_id && !resourceIsLink) {
    return { resourceId: input.resource_id, qurlId: input.qurl_id };
  }
  let resource: Resource;
  try {
    resource = (await client.getQURL(input.resource_id)).data;
  } catch (error) {
    // The shared wrapper turns a missing key into its own guidance.
    // Only not-found and forbidden are what the guidance below describes; a
    // missing key, rate limits, 5xx, and transport failures keep their metadata.
    if (!(error instanceof QURLAPIError && [403, 404].includes(error.statusCode))) throw error;
    return {
      error:
        `Reading the resource to pick a link failed (HTTP ${error.statusCode}; ` +
        "the resource may not exist, or the API key may lack qurl:read). Passing qurl_id with a resource ID skips this link-selection read, but building the response still needs qurl:read.",
    };
  }
  const named = resourceIsLink ? input.resource_id : undefined;
  if (named) {
    const link = resource.qurls?.find((candidate) => candidate.qurl_id === named);
    if (resource.qurls && !link) {
      return { error: `Link ${named} is not on resource ${resource.resource_id}.` };
    }
    const status = link?.status;
    if (status && INACTIVE_LINK_STATUSES.has(status)) {
      return {
        error: `Link ${named} is ${status}, so it cannot be extended. Use mint_link to issue a new one.`,
      };
    }
    // A read without the link list cannot be spliced; the handler rereads.
    return {
      resourceId: resource.resource_id,
      qurlId: named,
      ...(resource.qurls ? { resource } : {}),
    };
  }
  if (!resource.qurls) {
    return { error: "The resource read did not include its links; pass qurl_id to choose one." };
  }
  const active = resource.qurls.filter((link) => !INACTIVE_LINK_STATUSES.has(link.status));
  if (active.length === 1) {
    return { resourceId: resource.resource_id, qurlId: active[0].qurl_id, resource };
  }
  if (active.length === 0) {
    return {
      error:
        resource.qurls.length === 0
          ? "This resource has no link to extend. Use mint_link to issue one."
          : "No link on this resource can be extended (all are consumed, expired, or revoked). Use mint_link to issue a new one.",
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
      "Requires `qurl:write` and `qurl:read` (it reads the resource to pick the link and to return it); passing `qurl_id` with a resource ID skips the link-selection read. " +
      "A link cannot outlive its resource: if the resource's own `expires_at` is sooner, raise it with `update_qurl` first; the result then carries `extend_warning`. " +
      "Link-selection problems return an error result; a rejected update throws with its HTTP status and error code. " +
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
      // A token update leaves resource fields alone, so a resource already read
      // to pick the link only needs the updated link merged in (a merge, so a
      // sparser update response cannot drop fields the read had). Only the
      // qurl_id fast path, which skipped that read, reads after the update.
      let resource = target.resource;
      if (resource) {
        resource = {
          ...resource,
          qurls: resource.qurls?.map((link) =>
            link.qurl_id === qurlId ? { ...link, ...token.data } : link,
          ),
        };
      } else {
        try {
          resource = (await client.getQURL(resourceId)).data;
        } catch (error) {
          // The extension already happened; a retry would push the link out twice.
          // isError is deliberate: the declared output is the resource shape, which
          // this path cannot produce, and a success without it would fail hosts that
          // validate structuredContent. The text carries the new expiry.
          console.error(
            `extend_qurl extended ${qurlId} but reading the resource failed (${formatErrorForLog(error)})`,
          );
          return errorResult(
            `Link ${qurlId} was extended; it now expires at ${token.data.expires_at ?? "the new time"}. ` +
              "Do not retry. Reading the updated resource failed (the API key may lack qurl:read).",
          );
        }
      }
      // A link cannot outlive its resource. Warn when the link now ends at or past
      // the resource's expiry: stored past it, or clamped to it on write.
      const linkExpiry = Date.parse(token.data.expires_at ?? "");
      const ceiling = Date.parse(resource.expires_at ?? "");
      const data =
        Number.isFinite(ceiling) && linkExpiry >= ceiling
          ? {
              ...resource,
              extend_warning: `Link ${qurlId} expires at ${token.data.expires_at}, but its resource closes at ${resource.expires_at}, so it stops working then; raise the resource with update_qurl (extend_by up to 30d, or expires_at for further out).`,
            }
          : resource;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: toStructuredContent(data),
      };
    }),
  };
}
