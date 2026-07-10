import { describe, expect, it, vi } from "vitest";
import {
  getRequestMaxUploadFileDataBytes,
  getRequestQurlApiKey,
  getRequestQurlConnectorUrl,
  markRequestCredentialValidated,
  runWithRequestAuthContext,
} from "../../auth/request-context.js";

describe("request auth context", () => {
  it("keeps request-scoped credentials and limits inside the async call chain", async () => {
    expect(getRequestQurlApiKey()).toBeUndefined();
    expect(getRequestQurlConnectorUrl()).toBeUndefined();
    expect(getRequestMaxUploadFileDataBytes()).toBeUndefined();

    await runWithRequestAuthContext(
      {
        qurlApiKey: "  lv_live_request  ",
        qurlConnectorUrl: "  https://connector.example.com  ",
        maxUploadFileDataBytes: 42,
      },
      async () => {
        await Promise.resolve();
        expect(getRequestQurlApiKey()).toBe("lv_live_request");
        expect(getRequestQurlConnectorUrl()).toBe("https://connector.example.com");
        expect(getRequestMaxUploadFileDataBytes()).toBe(42);
      },
    );

    expect(getRequestQurlApiKey()).toBeUndefined();
    expect(getRequestQurlConnectorUrl()).toBeUndefined();
    expect(getRequestMaxUploadFileDataBytes()).toBeUndefined();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "rejects invalid request upload limit %s",
    async (maxUploadFileDataBytes) => {
      await runWithRequestAuthContext({ maxUploadFileDataBytes }, async () => {
        expect(getRequestMaxUploadFileDataBytes()).toBeUndefined();
      });
    },
  );

  it("marks a credential only when the active request provides a callback", async () => {
    const markCredentialValidated = vi.fn();
    markRequestCredentialValidated();

    await runWithRequestAuthContext({ markCredentialValidated }, async () => {
      markRequestCredentialValidated();
    });

    expect(markCredentialValidated).toHaveBeenCalledOnce();
  });
});
