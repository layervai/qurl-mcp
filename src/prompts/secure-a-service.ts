import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const secureAServiceArgs = {
  target_url: z.string().describe("The URL of the service to protect with QURL"),
  label: z
    .string()
    .optional()
    .describe("Human-readable label identifying who this QURL is for"),
  expires_in: z
    .string()
    .optional()
    .describe('How long the link should be valid (e.g., "1h", "24h", "7d")'),
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
      const parts = [
        `Create a QURL to protect the following service: ${args.target_url}`,
      ];

      if (args.label) {
        parts.push(`Label: ${args.label}`);
      }

      parts.push("");
      parts.push("Use the create_qurl tool with the following parameters:");
      parts.push(`- target_url: ${args.target_url}`);

      if (args.label) {
        parts.push(`- label: ${args.label}`);
      }
      if (args.expires_in) {
        parts.push(`- expires_in: ${args.expires_in}`);
      }
      if (args.session_duration) {
        parts.push(`- session_duration: ${args.session_duration}`);
      }

      parts.push("");
      parts.push(
        "After creating the QURL, explain the returned qurl_link and how to share it securely. " +
          "Note that the qurl_link is ephemeral and shown only once — it should be shared immediately. " +
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
