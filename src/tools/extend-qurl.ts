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

// qurl-service embeds at most this many links on a resource read
// (ResourceQurlPreviewLimit), revoked and expired ones included.
const RESOURCE_LINK_PREVIEW_LIMIT = 100;

// Whether resource.qurls lists every link. qurl_count counts all retained
// links, revoked and expired included (OpenAPI Resource.qurl_count), and the
// preview lists those too, so a revoked link does not make the list look
// short; when qurl_count is omitted, only a list under the cap is known whole.
function linkListComplete(resource: Resource): boolean {
  // A list at the cap is never trusted as whole, whatever qurl_count says.
  const listed = resource.qurls?.length ?? 0;
  return (
    listed < RESOURCE_LINK_PREVIEW_LIMIT &&
    (resource.qurl_count === undefined || resource.qurl_count <= listed)
  );
}

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
  // Always read before updating, even when the link is named: the read checks
  // the link is on this resource and still active, and a missing qurl:read
  // fails here, before the non-idempotent update, not after it.
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
        "the resource may not exist, or the API key may lack qurl:read). Nothing was extended.",
    };
  }
  const named = resourceIsLink ? input.resource_id : input.qurl_id;
  const complete = linkListComplete(resource);
  if (named) {
    const link = resource.qurls?.find((candidate) => candidate.qurl_id === named);
    // Only a complete list proves absence; past the preview cap the token
    // route decides, and the handler rereads since there is nothing to splice.
    if (resource.qurls && !link && complete) {
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
      ...(link ? { resource } : {}),
    };
  }
  if (!resource.qurls) {
    return {
      error:
        resource.qurl_count === 0
          ? "This resource has no link to extend. Use mint_link to issue one."
          : "The resource read did not include its links; pass qurl_id to choose one.",
    };
  }
  if (!complete) {
    return {
      error: `This resource's read may not list all of its links (it lists ${resource.qurls.length}, at most ${RESOURCE_LINK_PREVIEW_LIMIT}; ${resource.qurl_count ?? "unknown"} in total), so this server cannot tell which is the only active one; pass qurl_id to choose.`,
    };
  }
  const active = resource.qurls.filter(
    (link) => link.qurl_id && !INACTIVE_LINK_STATUSES.has(link.status),
  );
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
      "Pass a link's `q_` display ID as `resource_id`, or a resource ID plus `qurl_id`; a resource with exactly one active link needs no `qurl_id` (unless it has more than the 100 links a read lists). " +
      "Use this when the only change you need is more time on the clock. " +
      "Use `update_qurl_token` instead to set an absolute `expires_at` or change the link's label, policy, or sessions. " +
      "Use `revoke_qurl_token` or `delete_qurl` when you want to cut off access. " +
      "Links minted by the upload tools belong to the file connector and cannot be extended from this server. " +
      "**Not idempotent:** calling twice with the same `extend_by` extends the link twice; use `update_qurl_token` with `expires_at` when retries must not double-push. " +
      "Requires `qurl:write` and `qurl:read`: it reads the resource before updating, to check the link and to return it, so each extend costs two API calls (three when the read does not list the link). " +
      "A link cannot outlive its resource: if the resource's own `expires_at` is sooner, raise it with `update_qurl` first; the result then carries `extend_warning`. " +
      "Link-selection problems return an error result; a rejected update throws with its HTTP status and error code. " +
      "Returns the resource (same shape as `get_qurl`); the extended link's new expiry is in `extended_link_expires_at` (and `qurls[].expires_at`), not the resource's own `expires_at`.",
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
      // sparser update response cannot drop fields the read had). Only a read
      // that omitted the link list is repeated after the update.
      let resource = target.resource;
      if (resource) {
        resource = {
          ...resource,
          qurls: resource.qurls?.map((link) =>
            link.qurl_id === qurlId
              ? // Without a new expiry in the response, do not keep showing the old one.
                {
                  ...link,
                  ...token.data,
                  ...(token.data.expires_at ? {} : { expires_at: undefined }),
                }
              : link,
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
      // The change is on the link, so name it at the top level; the resource's
      // own expires_at is the ceiling, not the new expiry.
      const extended = {
        ...resource,
        extended_qurl_id: qurlId,
        ...(token.data.expires_at ? { extended_link_expires_at: token.data.expires_at } : {}),
      };
      const data =
        Number.isFinite(ceiling) && linkExpiry >= ceiling
          ? {
              ...extended,
              extend_warning: `Link ${qurlId} expires at ${token.data.expires_at}, but its resource closes at ${resource.expires_at}, so it stops working then; raise the resource with update_qurl (extend_by up to 30d, or expires_at for further out).`,
            }
          : extended;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: toStructuredContent(data),
      };
    }),
  };
}
