import { z, type ZodError } from "zod";

/**
 * Convert a ZodError into an MCP tool error result.
 *
 * Used by tools that register a base schema with the MCP SDK and re-parse
 * with a refined schema inside the handler — the MCP SDK cannot serialize
 * Zod refinements to JSON Schema, so cross-field constraints have to be
 * checked at call time and converted into a tool error response.
 */
export function zodErrorToToolResult(error: ZodError) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: error.issues.map((i) => i.message).join("; "),
      },
    ],
  };
}

/**
 * Zod schema for a tool's resource_id parameter.
 *
 * The API accepts both a resource ID (r_ prefix) and a QURL display ID
 * (q_ prefix) on get/update/extend/mint_link, and resolves a q_ ID to its
 * parent resource automatically. DELETE is the one exception — it only
 * accepts r_ IDs and defines its own schema.
 *
 * Rejects empty strings so a malformed call can't hit `/v1/qurls/` with
 * an empty path segment.
 */
export function resourceIdSchema(verb: string) {
  return z
    .string()
    .min(1)
    .describe(
      `The resource ID (r_ prefix) or QURL display ID (q_ prefix) to ${verb}. ` +
        "If a q_ ID is passed, the API resolves it to the parent resource automatically.",
    );
}
