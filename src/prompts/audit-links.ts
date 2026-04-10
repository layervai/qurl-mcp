import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export function auditLinksPrompt() {
  return {
    name: "audit-links",
    description:
      "Review all active QURLs and identify expiring links, token counts, or potential issues.",
    handler: (): GetPromptResult => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Audit my active QURL links. Follow these steps:",
                "",
                "1. Use the list_qurls tool to fetch all active QURLs.",
                "2. For each QURL, evaluate:",
                "   - Is it expiring within the next 24 hours?",
                "   - How many access tokens does it have (qurl_count)?",
                "   - Is it missing a description?",
                "3. Summarize findings in a table with columns: resource_id, target_url, status, expires_at, qurl_count, and any flags.",
                "4. Recommend actions for any issues found (extend, delete, or add description).",
              ].join("\n"),
            },
          },
        ],
      };
    },
  };
}
