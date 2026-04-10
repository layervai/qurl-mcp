import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const rotateAccessArgs = {
  resource_id: z.string().describe("The resource ID of the QURL to rotate"),
  expires_in: z
    .string()
    .optional()
    .describe('New expiration duration for the replacement QURL (e.g., "24h", "168h")'),
};

type RotateAccessInput = z.infer<z.ZodObject<typeof rotateAccessArgs>>;

export function rotateAccessPrompt() {
  return {
    name: "rotate-access",
    description:
      "Rotate a QURL by revoking the existing link and creating a fresh one with the same target.",
    args: rotateAccessArgs,
    handler: (args: RotateAccessInput): GetPromptResult => {
      const expiry = args.expires_in ?? "24h";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Rotate access for QURL ${args.resource_id}. Follow these steps:`,
                "",
                `1. Use the get_qurl tool to fetch the current details for resource_id "${args.resource_id}".`,
                "2. Note the target_url and description from the existing QURL.",
                `3. Use the delete_qurl tool to revoke the old QURL "${args.resource_id}".`,
                `4. Use the create_qurl tool to create a new QURL with the same target_url and description, but with expires_in set to "${expiry}".`,
                "5. Confirm the rotation was successful and provide the new qurl_link.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  };
}
