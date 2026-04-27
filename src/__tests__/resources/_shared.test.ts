import { describe, it, expect } from "vitest";
import { QURLAPIError } from "../../client.js";
import { withMissingApiKeyResource } from "../../resources/_shared.js";

const URI = "qurl://test";

describe("withMissingApiKeyResource", () => {
  it("converts a thrown missing_api_key error into a resource read with error JSON", async () => {
    const inner = async () => {
      throw new QURLAPIError(0, "missing_api_key", "QURL_API_KEY is not set.");
    };
    const wrapped = withMissingApiKeyResource(URI, inner);

    const result = await wrapped();

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe(URI);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0].text)).toEqual({
      error: { code: "missing_api_key", message: "QURL_API_KEY is not set." },
    });
  });

  it("propagates non-missing-key QURLAPIError as a thrown exception", async () => {
    const inner = async () => {
      throw new QURLAPIError(404, "not_found", "Resource not found");
    };
    const wrapped = withMissingApiKeyResource(URI, inner);

    await expect(wrapped()).rejects.toMatchObject({
      name: "QURLAPIError",
      code: "not_found",
      statusCode: 404,
    });
  });

  it("propagates non-QURLAPIError exceptions unchanged", async () => {
    const inner = async () => {
      throw new TypeError("unrelated bug");
    };
    const wrapped = withMissingApiKeyResource(URI, inner);

    await expect(wrapped()).rejects.toThrow(TypeError);
  });

  it("passes through successful results unchanged", async () => {
    const success = {
      contents: [{ uri: URI, mimeType: "application/json", text: '{"ok":true}' }],
    };
    const inner = async () => success;
    const wrapped = withMissingApiKeyResource(URI, inner);

    expect(await wrapped()).toBe(success);
  });
});
