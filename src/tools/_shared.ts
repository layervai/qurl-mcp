import { z, type ZodError } from "zod";
import { QURLAPIError } from "../client.js";

/**
 * Tool result shape that handlers return. Kept structural so we don't
 * take a hard dep on the MCP SDK's internal types. `structuredContent`
 * is what the SDK validates against `outputSchema` when one is declared
 * on the tool; `content` carries the human-readable JSON for display.
 */
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * MCP tool behavioral annotations — hints to the host for safety / UX
 * surfacing. Mirrors `ToolAnnotations` from the MCP SDK without taking
 * a value-level dep on it (the SDK type lives behind a deep import).
 *
 * - `readOnlyHint` — tool does not modify server state (list, get, resolve).
 * - `destructiveHint` — tool may delete or revoke (delete, optionally rotate).
 * - `idempotentHint` — repeated calls with the same args yield the same effect.
 * - `openWorldHint` — tool reaches an external service whose state the host
 *   cannot model. True for everything here since we hit the qURL API.
 */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

// SDK's `structuredContent` is `Record<string, unknown>`; payloads are
// typed against API response shapes. Single seam for the cast.
export function toStructuredContent<T>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/**
 * Wrap a tool handler so that a thrown `QURLAPIError` with
 * `code: "missing_api_key"` is converted into an `isError: true` content
 * block instead of propagating as a JSON-RPC error. MCP hosts surface
 * `isError: true` content blocks more prominently than transport-level
 * errors, so a missing-key misconfig becomes immediately actionable in
 * the host UI rather than buried in a generic error toast.
 *
 * Other API errors continue to throw — they're real failures that callers
 * should treat as exceptional, and the JSON-RPC error path carries the
 * statusCode/code metadata the host needs to surface them properly.
 */
export function withMissingApiKeyHandler<I>(
  inner: (input: I) => Promise<ToolResult>,
): (input: I) => Promise<ToolResult> {
  return async (input) => {
    try {
      return await inner(input);
    } catch (err) {
      if (err instanceof QURLAPIError && err.code === "missing_api_key") {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }
      throw err;
    }
  };
}

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
 * The API accepts both a resource ID (r_ prefix) and a qURL display ID
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
      `The resource ID (r_ prefix) or qURL display ID (q_ prefix) to ${verb}. ` +
        "If a q_ ID is passed, the API resolves it to the parent resource automatically.",
    );
}
