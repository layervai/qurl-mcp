import type { IQURLClient } from "../client.js";

export function linksResource(client: IQURLClient) {
  const uri = "qurl://links";
  const mimeType = "application/json";
  return {
    uri,
    name: "Active QURL Links",
    description: "List of all active QURL links",
    mimeType,
    handler: async () => {
      const result = await client.listQURLs({ limit: 50 });
      return {
        contents: [{ uri, mimeType, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  };
}
