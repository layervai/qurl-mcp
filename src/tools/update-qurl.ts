import { z } from "zod";
import type { IQURLClient, UpdateQURLInput, UpdateResourceInput } from "../client.js";
import {
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { updateQurlOutputSchema } from "./output-schemas.js";

// Tags must match the API constraints: 1-50 chars, start with alphanumeric,
// allow alphanumerics/spaces/underscores/hyphens. Max 10 tags per resource.
// See qurl/api/openapi.yaml -> UpdateQurlRequest.tags.
const tagSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
    "Tag must start with alphanumeric and contain only letters, numbers, spaces, underscores, or hyphens",
  );

export const updateQurlBaseSchema = z.object({
  resource_id: resourceIdSchema("update"),
  extend_by: z
    .string()
    .min(1)
    .optional()
    .describe('Duration to extend by (e.g., "24h", "7d"). Mutually exclusive with expires_at.'),
  expires_at: z
    .string()
    .datetime()
    .optional()
    .describe("Absolute expiration timestamp (RFC 3339). Mutually exclusive with extend_by."),
  tags: z
    .array(tagSchema)
    .max(10)
    .optional()
    .describe("Replace all tags on this resource (max 10 tags, each 1-50 chars)"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Replace the resource description (max 500 chars)"),
  custom_domain: z
    .string()
    .max(253)
    .optional()
    .describe(
      "Replace the custom domain bound to this resource (max 253 chars, must be registered/active/owned). " +
        'Pass "" to clear.',
    ),
  preserve_host: z
    .boolean()
    .optional()
    .describe(
      "Whether to preserve the original Host header when proxying via the custom domain. " +
        "Only meaningful when custom_domain is set; default false on the API side.",
    ),
});

export const updateQurlSchema = updateQurlBaseSchema
  .refine((data) => !(data.extend_by && data.expires_at), {
    message: "Provide either extend_by or expires_at, not both",
  })
  .refine((data) => !(hasExpirationUpdate(data) && hasResourceEndpointUpdate(data)), {
    message:
      "custom_domain and preserve_host use the resource endpoint and cannot be combined with extend_by or expires_at in one update",
  })
  .refine((data) => !(hasResourceEndpointUpdate(data) && data.resource_id.startsWith("q_")), {
    message: "custom_domain and preserve_host updates require an r_ resource ID",
  })
  .refine(
    // Use `!== undefined` rather than truthy checks so the API's "clear"
    // semantics work: the spec documents `description: ""` and `tags: []`
    // as valid payloads that clear the field, and the same applies to
    // `custom_domain: ""`. A plain `||` would reject these because
    // empty string / empty array / `false` are falsy in JS.
    (data) =>
      data.extend_by !== undefined ||
      data.expires_at !== undefined ||
      data.tags !== undefined ||
      data.description !== undefined ||
      data.custom_domain !== undefined ||
      data.preserve_host !== undefined,
    {
      message:
        "At least one update field (extend_by, expires_at, tags, description, custom_domain, or preserve_host) is required",
    },
  );

export function updateQurlTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "update_qurl",
    title: "Update qURL",
    description:
      "Update a qURL's expiration, tags, description, custom domain, or proxy host-header behavior. The richer alternative to `extend_qurl` — use `update_qurl` whenever you need anything beyond a relative time push. " +
      "Accepts both `r_` and `q_` IDs for expiration, tags, and description updates (q_ is auto-resolved); custom domain and preserve_host updates require an `r_` resource ID because the qURL API now serves them from `PATCH /v1/resources/{id}`. " +
      "**Constraints:** `extend_by` and `expires_at` are mutually exclusive; `custom_domain`/`preserve_host` cannot be combined with expiration changes in one call; at least one update field (`extend_by`, `expires_at`, `tags`, `description`, `custom_domain`, `preserve_host`) must be set. " +
      '**Clearing fields:** pass `description: ""`, `tags: []`, or `custom_domain: ""` to clear those fields explicitly. ' +
      "Use `extend_qurl` when the only change is a relative time push. " +
      "Use `delete_qurl` when you want to revoke entirely. " +
      "**Errors:** if the input fails schema refinements (both extend_by + expires_at, or no fields set), the handler returns an `isError: true` content block before any API call. Other API errors throw with the API's `code`/`statusCode`. " +
      "Returns the updated resource (same shape as `get_qurl`).",
    // Base shape for MCP tool registration; refinements run in the handler
    inputSchema: updateQurlBaseSchema,
    outputSchema: updateQurlOutputSchema,
    annotations: {
      title: "Update qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof updateQurlBaseSchema>) => {
      const parsed = updateQurlSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const { resource_id } = parsed.data;
      // Both API endpoints accept tags/description; keep qURL-only updates
      // on /v1/qurls/{id} for q_ auto-resolution, and move custom-domain /
      // host-header changes to /v1/resources/{id} per UpdateResourceRequest.
      const result = hasResourceEndpointUpdate(parsed.data)
        ? await client.updateResource(resource_id, buildResourceUpdateBody(parsed.data))
        : await client.updateQURL(resource_id, buildQurlUpdateBody(parsed.data));
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

type ParsedUpdateQurl = z.infer<typeof updateQurlBaseSchema>;

function hasExpirationUpdate(data: ParsedUpdateQurl) {
  return data.extend_by !== undefined || data.expires_at !== undefined;
}

function hasResourceEndpointUpdate(data: ParsedUpdateQurl) {
  return data.custom_domain !== undefined || data.preserve_host !== undefined;
}

function buildQurlUpdateBody(data: ParsedUpdateQurl): UpdateQURLInput {
  const body: UpdateQURLInput = {};
  if (data.extend_by !== undefined) body.extend_by = data.extend_by;
  if (data.expires_at !== undefined) body.expires_at = data.expires_at;
  if (data.tags !== undefined) body.tags = data.tags;
  if (data.description !== undefined) body.description = data.description;
  return body;
}

function buildResourceUpdateBody(data: ParsedUpdateQurl): UpdateResourceInput {
  const body: UpdateResourceInput = {};
  if (data.tags !== undefined) body.tags = data.tags;
  if (data.description !== undefined) body.description = data.description;
  if (data.custom_domain !== undefined) body.custom_domain = data.custom_domain;
  if (data.preserve_host !== undefined) body.preserve_host = data.preserve_host;
  return body;
}
