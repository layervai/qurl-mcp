import type { IQURLClient } from "../client.js";

export function usageResource(client: IQURLClient) {
  const uri = "qurl://usage";
  const mimeType = "application/json";
  return {
    uri,
    name: "QURL Usage & Quota",
    description: "Current quota and usage information",
    mimeType,
    handler: async () => {
      const result = await client.getQuota();
      return {
        contents: [{ uri, mimeType, text: JSON.stringify(result.data) }],
      };
    },
  };
}
