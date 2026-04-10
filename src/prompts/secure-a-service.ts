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
};

type SecureAServiceInput = z.infer<z.ZodObject<typeof secureAServiceArgs>>;

export function secureAServicePrompt() {
  return {
    name: "secure-a-service",
    description:
      "Guide through creating a QURL to protect a service with appropriate security policies.",
    args: secureAServiceArgs,
    handler: (args: SecureAServiceInput): GetPromptResult => {
      const optionalParams: [string, string | boolean | undefined][] = [
        ["label", args.label],
        ["description", args.description],
        ["expires_in", args.expires_in],
        // "false" (truthy string) → false (boolean), undefined → omitted from output.
        ["one_time_use", args.one_time_use ? args.one_time_use === "true" : undefined],
        ["max_sessions", args.max_sessions],
        ["session_duration", args.session_duration],
      ];
      const paramLines = optionalParams
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `- ${key}: ${value}`);

      const text = [
        `Create a QURL to protect the following service: ${args.target_url}`,
        ...(args.label ? [`Label: ${args.label}`] : []),
        ...(args.description ? [`Description: ${args.description}`] : []),
        "",
        "Use the create_qurl tool with the following parameters:",
        `- target_url: ${args.target_url}`,
        ...paramLines,
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
