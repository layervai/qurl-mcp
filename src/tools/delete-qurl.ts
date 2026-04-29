import { z } from "zod";
import { type IQURLClient, QURLAPIError } from "../client.js";
import { withMissingApiKeyHandler } from "./_shared.js";
import { deleteQurlOutputSchema } from "./output-schemas.js";

export const deleteQurlSchema = z.object({
  // DELETE only accepts r_ (resource) IDs per the API spec — unlike
  // get/update/extend/mint_link which also accept q_ prefixes. Reject
  // non-r_ IDs at the schema boundary so agents get a clear error
  // instead of a confusing API-side rejection.
  resource_id: z
    .string()
    .min(1)
    .startsWith("r_", "delete_qurl only accepts resource IDs (r_ prefix). Use update_qurl or mint_link for q_ IDs.")
    .describe(
      "The resource ID (must start with r_). delete_qurl does not accept q_ (qURL display) IDs.",
    ),
});

export function deleteQurlTool(client: IQURLClient) {
  return {
    name: "delete_qurl",
    title: "Delete qURL",
    description:
      "Permanently revoke a qURL — the link and every access token under it stop working immediately. " +
      "**This action is irreversible.** Use this when you want to cut off access entirely (compromised link, departed user, end-of-engagement). " +
      "Use `update_qurl` instead when you only need to shorten/extend the expiration, retag, or rename — those preserve the existing access tokens. " +
      "Use `extend_qurl` when you only need to push the expiration out. " +
      "**Idempotent:** the API returns 404 for re-deletes, never-existed IDs, and resources owned by another API key (ownership-mismatch is collapsed into 404 server-side to avoid existence disclosure); this tool swallows all three. " +
      "Branch on `was_already_revoked` to distinguish the no-op case from an actual revoke; `get_qurl` first when the ID came from user input and you need to confirm ownership. " +
      "Returns a confirmation payload. By default the resource is excluded from `list_qurls`; pass `status: \"revoked\"` to see it.",
    inputSchema: deleteQurlSchema,
    outputSchema: deleteQurlOutputSchema,
    annotations: {
      title: "Delete qURL",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof deleteQurlSchema>) => {
      let wasAlreadyRevoked = false;
      try {
        await client.deleteQURL(input.resource_id);
      } catch (err) {
        // Re-delete of an already-revoked (or never-existed) resource:
        // the API returns 404, but the agent's intent ("this resource
        // should not be live") is already satisfied. Swallow the throw
        // so the tool is genuinely idempotent, but expose
        // `was_already_revoked: true` in the payload so defensive
        // agents can branch when they care.
        //
        // Verified against qurl-service: the service-layer
        // `RevokeQurl` collapses ownership-mismatch into
        // `ErrResourceNotFound` (qurl-service/internal/service/
        // qurl_service.go:407-409) — i.e. 404 here also covers
        // "you don't own this resource." That collapse is server-side
        // policy to avoid existence disclosure; the tool description
        // documents the conflation so callers who need to confirm
        // ownership can `get_qurl` first.
        //
        // Intentionally checks status only, not `code`. A 404 with a
        // non-JSON body (e.g. an HTML error page from a proxy in front
        // of the API) lands here as `code: "parse_error"` — the
        // resource still isn't live, so treating it as already-revoked
        // is the right behavior; defensive agents see that via the
        // `was_already_revoked` flag.
        if (!(err instanceof QURLAPIError) || err.statusCode !== 404) throw err;
        wasAlreadyRevoked = true;
      }
      const payload = {
        resource_id: input.resource_id,
        revoked: true as const,
        was_already_revoked: wasAlreadyRevoked,
        message: `qURL ${input.resource_id} is revoked.`,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: payload.message,
          },
        ],
        structuredContent: payload,
      };
    }),
  };
}
