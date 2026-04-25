import type { IQURLClient } from "../client.js";

// Hard cap on the informational resource. Resource reads are snapshot-style —
// callers that need full pagination should use the list_qurls tool directly.
const LINKS_RESOURCE_LIMIT = 50;

export function linksResource(client: IQURLClient) {
  const uri = "qurl://links";
  const mimeType = "application/json";
  return {
    uri,
    name: "Active qURL Links",
    description:
      `Snapshot of up to ${LINKS_RESOURCE_LIMIT} active qURL links (most recent first). ` +
      "For full pagination use the list_qurls tool.",
    mimeType,
    handler: async () => {
      const result = await client.listQURLs({ limit: LINKS_RESOURCE_LIMIT });
      return {
        contents: [{ uri, mimeType, text: JSON.stringify(result.data) }],
      };
    },
  };
}
