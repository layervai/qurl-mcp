import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const secureAServiceArgs = {
  target_url: z.string().describe("The URL of the service to protect with QURL"),
  label: z
    .string()
    .optional()
    .describe("Human-readable label identifying who this QURL is for"),
  description: z
    .string()
    .optional()
    .describe("Human-readable description of what this service is"),
  expires_in: z
    .string()
    .optional()
    .describe('How long the link should be valid (e.g., "1h", "24h", "7d")'),
  one_time_use: z
    .enum(["true", "false"])
    .optional()
    .describe("Whether the link should be single-use"),
  max_sessions: z
    .string()
    .regex(/^[1-9]\d*$/, "Must be a positive integer")
    .optional()
    .describe("Maximum number of concurrent sessions (e.g., \"1\", \"5\")"),
  session_duration: z
    .string()
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h")'),
  ip_allowlist: z
    .string()
    .optional()
    .describe("Comma-separated IP addresses or CIDR ranges allowed to access (e.g., \"10.0.0.0/8,192.168.1.1\")"),
  ip_denylist: z
    .string()
    .optional()
    .describe("Comma-separated IP addresses or CIDR ranges to block"),
  geo_allowlist: z
    .string()
    .optional()
    .describe("Comma-separated ISO 3166-1 alpha-2 country codes allowed (e.g., \"US,CA,GB\")"),
  geo_denylist: z
    .string()
    .optional()
    .describe("Comma-separated country codes to block (e.g., \"CN,RU\")"),
  block_ai_agents: z
    .enum(["true", "false"])
    .optional()
    .describe("Block all recognized AI agents (bots, scrapers, LLM crawlers)"),
};

type SecureAServiceInput = z.infer<z.ZodObject<typeof secureAServiceArgs>>;

/** Split comma-separated string into a trimmed, non-empty array. */
function csvToArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function secureAServicePrompt() {
  return {
    name: "secure-a-service",
    description:
      "Guide through creating a QURL to protect a service with appropriate security policies " +
      "(expiration, session limits, IP/geo allowlists, AI-agent blocking).",
    args: secureAServiceArgs,
    handler: (args: SecureAServiceInput): GetPromptResult => {
      // Note: `description` is NOT a valid create_qurl field — it lives on the
      // resource and must be applied via update_qurl after creation.
      const optionalParams: [string, string | boolean | undefined][] = [
        ["label", args.label],
        ["expires_in", args.expires_in],
        // "false" (truthy string) → false (boolean), undefined → omitted from output.
        ["one_time_use", args.one_time_use ? args.one_time_use === "true" : undefined],
        ["max_sessions", args.max_sessions],
        ["session_duration", args.session_duration],
      ];
      const paramLines = optionalParams
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `- ${key}: ${value}`);

      const ipAllow = csvToArray(args.ip_allowlist);
      const ipDeny = csvToArray(args.ip_denylist);
      const geoAllow = csvToArray(args.geo_allowlist);
      const geoDeny = csvToArray(args.geo_denylist);
      const blockAI = args.block_ai_agents === "true";
      const hasPolicy =
        ipAllow !== undefined ||
        ipDeny !== undefined ||
        geoAllow !== undefined ||
        geoDeny !== undefined ||
        blockAI;

      const policy: Record<string, unknown> = {};
      if (ipAllow) policy.ip_allowlist = ipAllow;
      if (ipDeny) policy.ip_denylist = ipDeny;
      if (geoAllow) policy.geo_allowlist = geoAllow;
      if (geoDeny) policy.geo_denylist = geoDeny;
      if (blockAI) policy.ai_agent_policy = { block_all: true };

      const policyLines = hasPolicy
        ? [`- access_policy: ${JSON.stringify(policy)}`]
        : [];

      const descriptionFollowUp = args.description
        ? [
            "",
            `Then call update_qurl with the returned resource_id and description: "${args.description}".`,
          ]
        : [];

      const text = [
        `Create a QURL to protect the following service: ${args.target_url}`,
        ...(args.label ? [`Label: ${args.label}`] : []),
        ...(args.description ? [`Description: ${args.description}`] : []),
        "",
        "Use the create_qurl tool with the following parameters:",
        `- target_url: ${args.target_url}`,
        ...paramLines,
        ...policyLines,
        ...descriptionFollowUp,
        "",
        "After creating the QURL, explain the returned qurl_link and how to share it securely. " +
          "Note that the qurl_link is ephemeral and shown only once — it should be shared immediately. " +
          "Note the expiration time and any access restrictions that were applied.",
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    },
  };
}
