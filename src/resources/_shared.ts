import { QURLAPIError } from "../client.js";

/**
 * Resource result shape that handlers return. Kept structural so we don't
 * take a hard dep on the MCP SDK's internal types.
 */
type ResourceResult = {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
};

/**
 * Wrap a resource handler so that a thrown `QURLAPIError` with
 * `code: "missing_api_key"` is converted into a resource read whose
 * contents carry an error JSON payload, instead of propagating as a
 * JSON-RPC error.
 *
 * This mirrors `withMissingApiKeyHandler` from tools/_shared.ts and
 * keeps the deferred-auth UX consistent across the tool and resource
 * surfaces — a missing key surfaces the same actionable
 * `missing_api_key` message regardless of whether the caller invoked
 * `tools/call` or `resources/read`. MCP hosts display resource contents
 * in their resource viewer, so the JSON payload is what the user sees.
 *
 * Other API errors continue to throw — they're real failures and the
 * JSON-RPC error path carries the statusCode/code metadata the host
 * needs to surface them.
 */
export function withMissingApiKeyResource(
  uri: string,
  inner: () => Promise<ResourceResult>,
): () => Promise<ResourceResult> {
  return async () => {
    try {
      return await inner();
    } catch (err) {
      if (err instanceof QURLAPIError && err.code === "missing_api_key") {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({
                error: { code: err.code, message: err.message },
              }),
            },
          ],
        };
      }
      throw err;
    }
  };
}
