import type { QURLClient } from "../client.js";

export function usageResource(client: QURLClient) {
  return {
    uri: "qurl://usage",
    name: "QURL Usage & Quota",
    description: "Current quota and usage information",
    mimeType: "application/json",
    handler: async () => {
      const result = await client.getQuota();
      return {
        contents: [
          {
            uri: "qurl://usage",
            mimeType: "application/json",
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  };
}
