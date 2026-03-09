import type { QURLClient } from "../client.js";

export function linksResource(client: QURLClient) {
  return {
    uri: "qurl://links",
    name: "Active QURL Links",
    description: "List of all active QURL links",
    mimeType: "application/json",
    handler: async () => {
      const result = await client.listQURLs({ limit: 50 });
      return {
        contents: [
          {
            uri: "qurl://links",
            mimeType: "application/json",
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  };
}
