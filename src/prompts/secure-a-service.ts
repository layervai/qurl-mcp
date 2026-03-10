import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const secureAServiceArgs = {
  target_url: z.string().describe("The URL of the service to protect with QURL"),
  description: z
    .string()
    .optional()
    .describe("Human-readable description of what this service is"),
  expires_in: z
    .string()
    .optional()
    .describe('How long the link should be valid (e.g., "1h", "24h", "168h")'),
  one_time_use: z
    .string()
    .optional()
    .describe('Whether the link should be single-use ("true" or "false")'),
  max_sessions: z
    .string()
    .optional()
    .describe("Maximum number of concurrent sessions (e.g., \"1\", \"5\")"),
};

export function secureAServicePrompt() {
  return {
    name: "secure-a-service",
    description:
      "Guide through creating a QURL to protect a service with appropriate security policies.",
    args: secureAServiceArgs,
    handler: (args: {
      target_url: string;
      description?: string;
      expires_in?: string;
      one_time_use?: string;
      max_sessions?: string;
    }): GetPromptResult => {
      const parts = [
        `Create a QURL to protect the following service: ${args.target_url}`,
      ];

      if (args.description) {
        parts.push(`Description: ${args.description}`);
      }

      parts.push("");
      parts.push("Use the create_qurl tool with the following parameters:");
      parts.push(`- target_url: ${args.target_url}`);

      if (args.description) {
        parts.push(`- description: ${args.description}`);
      }
      if (args.expires_in) {
        parts.push(`- expires_in: ${args.expires_in}`);
      }
      if (args.one_time_use) {
        parts.push(`- one_time_use: ${args.one_time_use === "true"}`);
      }
      if (args.max_sessions) {
        parts.push(`- max_sessions: ${args.max_sessions}`);
      }

      parts.push("");
      parts.push(
        "After creating the QURL, explain the returned qurl_link and how to share it securely. " +
          "Note the expiration time and any access restrictions that were applied.",
      );

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: parts.join("\n") },
          },
        ],
      };
    },
  };
}
