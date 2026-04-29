import { z } from "zod";

/**
 * Output schemas for MCP tools.
 *
 * Each schema describes the **payload** a tool's `structuredContent` carries —
 * the inner data shape, not the API envelope. The text content of every tool
 * response already serializes this same payload, so structuredContent and
 * text describe the same value in two formats.
 *
 * The MCP SDK validates `structuredContent` against the `outputSchema` we
 * register on each tool. Hosts use the schema to render structured responses,
 * and downstream agents use it to plan their call shape — so keeping these
 * aligned with the API spec at `api-spec/qurls.yaml` is part of the API spec
 * drift workflow.
 *
 * Why URLs and timestamps are plain `z.string()` (not `.url()`/`.datetime()`):
 * these schemas validate API *responses*, not user input. A tighter local
 * validator that disagrees with the server (e.g. an `https://` redirect that
 * Zod's URL parser rejects, or a timestamp Go formats slightly differently
 * from RFC 3339 strict mode) would turn a valid API response into a tool
 * error for no benefit. We trust the server on shape and use `.string()` as
 * an existence/typeof check.
 */

const accessPolicy = z
  .object({
    ip_allowlist: z.array(z.string()).optional(),
    ip_denylist: z.array(z.string()).optional(),
    geo_allowlist: z.array(z.string()).optional(),
    geo_denylist: z.array(z.string()).optional(),
    user_agent_allow_regex: z.string().optional(),
    user_agent_deny_regex: z.string().optional(),
    ai_agent_policy: z
      .object({
        block_all: z.boolean().optional(),
        deny_categories: z.array(z.string()).optional(),
        allow_categories: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .describe("Access control policy snapshot for this token");

const accessTokenSchema = z
  .object({
    qurl_id: z.string(),
    label: z.string().optional(),
    // Same drift-tolerance rationale as qurlSchema.status — token-level
    // status is wider and just as exposed to a new server-side value
    // reaching a host between weekly snapshot runs.
    status: z
      .enum(["active", "consumed", "expired", "revoked", "unknown"])
      .catch("unknown")
      .describe("Per-token status (wider than resource status — tokens may be consumed/expired independently)"),
    one_time_use: z.boolean(),
    max_sessions: z.number(),
    session_duration: z.number().describe("Seconds of access granted after a successful resolve"),
    use_count: z.number(),
    qurl_site: z.string().optional(),
    access_policy: accessPolicy.optional(),
    created_at: z.string(),
    expires_at: z.string(),
  })
  .describe("Single access token belonging to a qURL resource");

/** Stable QURL resource shape returned by get/list/update/extend. */
export const qurlSchema = z.object({
  resource_id: z.string().describe("Stable resource identifier (r_ prefix)"),
  qurl_site: z.string().optional(),
  target_url: z.string().describe("Underlying URL the qURL protects"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  expires_at: z.string(),
  created_at: z.string(),
  // Enum sourced from api-spec/qurls.yaml. The spec-drift workflow
  // catches a new value at the snapshot level on its weekly run, but
  // not before it reaches a host. `.catch("unknown")` widens the
  // accepted set so an unanticipated value (e.g. "expired", "pending")
  // doesn't hard-fail `structuredContent` validation between drift
  // detections — it instead surfaces as the sentinel `unknown`, which
  // a defensive agent can branch on.
  status: z.enum(["active", "revoked", "unknown"]).catch("unknown"),
  custom_domain: z.string().nullable().optional(),
  preserve_host: z
    .boolean()
    .optional()
    .describe(
      "When true, the original Host header is preserved when proxying via the custom domain. " +
        "Only meaningful when custom_domain is set; defaults to false on the API side.",
    ),
  qurl_count: z.number().optional().describe("Number of access tokens minted for this resource"),
  qurls: z.array(accessTokenSchema).optional(),
});

/** Ephemeral create-time payload — note `qurl_link` is one-shot. */
export const createQurlOutputSchema = z.object({
  qurl_id: z.string().describe("Display-friendly qURL ID (q_ prefix)"),
  resource_id: z.string().describe("Stable resource identifier (r_ prefix)"),
  qurl_link: z
    .string()
    .describe("Single-use access link — shown ONCE on creation, never returned again. Share immediately."),
  qurl_site: z.string(),
  expires_at: z.string(),
  label: z.string().optional(),
});

export const getQurlOutputSchema = qurlSchema;
export const updateQurlOutputSchema = qurlSchema;
export const extendQurlOutputSchema = qurlSchema;

/**
 * Paginated list response. When `meta.has_more` is true, pass
 * `meta.next_cursor` as the `cursor` argument on the next call.
 */
export const listQurlsOutputSchema = z.object({
  data: z.array(qurlSchema),
  meta: z.object({
    next_cursor: z.string().optional().describe("Pass to a subsequent list_qurls call to fetch the next page"),
    has_more: z.boolean().describe("True if more pages are available beyond this response"),
    page_size: z.number().optional(),
    request_id: z.string().optional(),
  }),
});

/** Resolve response: target_url + the access_grant that opens the firewall. */
export const resolveQurlOutputSchema = z.object({
  target_url: z.string().describe("Underlying URL revealed by the resolve"),
  resource_id: z.string(),
  access_grant: z
    .object({
      expires_in: z
        .number()
        .describe("Seconds the firewall will permit access from `src_ip` before re-resolution is required"),
      granted_at: z.string(),
      src_ip: z.string().describe("Caller IP that the access grant is bound to"),
    })
    .describe("Time-bound, IP-bound access grant — required for the qURL firewall to permit the next request"),
});

/** Mint response: a fresh `qurl_link` for an existing resource. One-shot, like create_qurl. */
export const mintLinkOutputSchema = z.object({
  qurl_link: z.string().describe("Newly minted single-use access link (one-shot, like create_qurl)"),
  expires_at: z.string(),
});

// Discriminated on `success` so the schema enforces the API's
// mutual-exclusivity contract — a host or planner generating UI from
// the schema will only show success-fields under `success: true` and
// the `error` block under `success: false`, never both.
const batchItemSuccessSchema = z.object({
  index: z.number().describe("Index of the corresponding item in the input `items` array"),
  success: z.literal(true),
  resource_id: z.string(),
  qurl_link: z.string().describe("One-shot access link — shown ONCE on creation"),
  qurl_site: z.string(),
  expires_at: z.string(),
});

const batchItemFailureSchema = z.object({
  index: z.number().describe("Index of the corresponding item in the input `items` array"),
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const batchItemResultSchema = z
  .discriminatedUnion("success", [batchItemSuccessSchema, batchItemFailureSchema])
  .describe("Per-item result. Discriminated on `success`.");

/**
 * Batch creation response. The handler sets `isError: true` when `failed > 0`
 * so agents can branch on partial failure without parsing JSON. `request_id`
 * is hoisted from response metadata for support correlation.
 *
 * Schema flattens the `{ data, meta }` envelope on `BatchCreateOutput` —
 * `output-schemas.types.test.ts` asserts the flattened shape against the
 * client interface so drift on either side fails compilation.
 */
export const batchCreateOutputSchema = z.object({
  succeeded: z.number(),
  failed: z.number(),
  results: z.array(batchItemResultSchema),
  request_id: z.string().optional(),
});

/** Delete confirmation. The qURL is in a revoked state after this call. */
export const deleteQurlOutputSchema = z.object({
  resource_id: z.string(),
  revoked: z.literal(true),
  was_already_revoked: z
    .boolean()
    .describe(
      "True when the API responded 404 (resource was already revoked or never existed). " +
        "Agents that need to distinguish 'I revoked it' from 'it was already gone' should branch on this.",
    ),
  message: z.string().describe("Human-readable confirmation message"),
});
