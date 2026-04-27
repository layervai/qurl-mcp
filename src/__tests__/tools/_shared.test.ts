import { describe, it, expect } from "vitest";
import { MISSING_API_KEY_MESSAGE, QURLAPIError } from "../../client.js";
import { withMissingApiKeyHandler } from "../../tools/_shared.js";

describe("withMissingApiKeyHandler", () => {
  it("converts a thrown missing_api_key error into an isError content block", async () => {
    const inner = async () => {
      throw new QURLAPIError(0, "missing_api_key", MISSING_API_KEY_MESSAGE);
    };
    const wrapped = withMissingApiKeyHandler(inner);

    const result = await wrapped(undefined as unknown as never);

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: MISSING_API_KEY_MESSAGE }],
    });
  });

  it("propagates non-missing-key QURLAPIError as a thrown exception", async () => {
    // Real API failures (401, 404, 500, etc.) should keep flowing through
    // the JSON-RPC error path so the host surfaces statusCode/code metadata.
    const inner = async () => {
      throw new QURLAPIError(404, "not_found", "Resource not found");
    };
    const wrapped = withMissingApiKeyHandler(inner);

    await expect(wrapped(undefined as unknown as never)).rejects.toMatchObject({
      name: "QURLAPIError",
      code: "not_found",
      statusCode: 404,
    });
  });

  it("propagates non-QURLAPIError exceptions unchanged", async () => {
    const inner = async () => {
      throw new TypeError("unrelated bug");
    };
    const wrapped = withMissingApiKeyHandler(inner);

    await expect(wrapped(undefined as unknown as never)).rejects.toThrow(TypeError);
  });

  it("passes through successful results unchanged", async () => {
    const success = {
      content: [{ type: "text" as const, text: "ok" }],
    };
    const inner = async () => success;
    const wrapped = withMissingApiKeyHandler(inner);

    expect(await wrapped(undefined as unknown as never)).toBe(success);
  });
});
