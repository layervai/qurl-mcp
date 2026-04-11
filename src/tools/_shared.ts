import type { ZodError } from "zod";

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
