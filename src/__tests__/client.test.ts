import { describe, it, expect, vi, beforeEach } from "vitest";

// `client.ts` is now a thin adapter over the `@layervai/qurl` SDK. These tests
// mock the SDK so we can assert the adapter's translation layer in isolation:
// lazy/keyless construction, `{ data }` re-wrapping, the `access_tokens` →
// `qurls` rename, the list/batch/session envelope reshaping, the method
// renames, and the `QURLError` → `QURLAPIError` mapping. The HTTP/retry/parse
// behavior the old hand-rolled client used to be tested for now lives in (and
// is tested by) the SDK itself.

const { sdk, SDKClientMock } = vi.hoisted(() => {
  const sdk = {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    updateResource: vi.fn(),
    extend: vi.fn(),
    resolve: vi.fn(),
    getQuota: vi.fn(),
    mintLink: vi.fn(),
    batchCreate: vi.fn(),
    revokeResourceQurl: vi.fn(),
    updateResourceQurl: vi.fn(),
    listResourceSessions: vi.fn(),
    terminateResourceSession: vi.fn(),
    terminateAllResourceSessions: vi.fn(),
  };
  // The SDK constructor returns our shared stub instance. Must be a regular
  // function (not an arrow) so the adapter's `new SDKQURLClient(...)` works —
  // a constructor that returns an object makes `new` yield that object.
  const SDKClientMock = vi.fn(function () {
    return sdk;
  });
  return { sdk, SDKClientMock };
});

vi.mock("@layervai/qurl", async (importOriginal) => {
  // Keep the real error classes (so NotFoundError etc. behave like the SDK),
  // swap only the client constructor for our stub.
  const actual = await importOriginal<typeof import("@layervai/qurl")>();
  return { ...actual, QURLClient: SDKClientMock };
});

import { QURLClient, QURLAPIError, MISSING_API_KEY_MESSAGE } from "../client.js";
import { NotFoundError, AuthorizationError, NetworkError } from "@layervai/qurl";

const newClient = (apiKey = "lv_live_key", baseURL = "https://api.test.layerv.ai") =>
  new QURLClient({ apiKey, baseURL });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QURLClient adapter", () => {
  describe("keyless boot", () => {
    it("does not construct the SDK when no key is configured", () => {
      expect(() => newClient("")).not.toThrow();
      expect(SDKClientMock).not.toHaveBeenCalled();
    });

    it("defers the missing-key error to the first API call (status 0, code missing_api_key)", async () => {
      // Whitespace-only keys take the same path as truly unset.
      const client = newClient("   ");
      const err = (await client.getQURL("r_x").catch((e: unknown) => e)) as QURLAPIError;

      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.code).toBe("missing_api_key");
      expect(err.statusCode).toBe(0);
      expect(err.message).toBe(MISSING_API_KEY_MESSAGE);
      // The SDK (which throws on an empty key) is never constructed.
      expect(SDKClientMock).not.toHaveBeenCalled();
    });
  });

  describe("lazy SDK construction", () => {
    it("constructs the SDK once, mapping baseURL → baseUrl and trimming the trailing slash", async () => {
      sdk.get.mockResolvedValue({ resource_id: "r_x" });
      const client = newClient("lv_live_key", "https://api.test.layerv.ai/");

      await client.getQURL("r_x");
      await client.getQURL("r_y");

      expect(SDKClientMock).toHaveBeenCalledTimes(1);
      expect(SDKClientMock).toHaveBeenCalledWith({
        apiKey: "lv_live_key",
        baseUrl: "https://api.test.layerv.ai",
      });
    });
  });

  describe("shape translation", () => {
    it("createQURL passes the input through and wraps the result in { data }", async () => {
      sdk.create.mockResolvedValue({
        qurl_id: "q_x",
        resource_id: "r_x",
        qurl_link: "https://qurl.link/#at_x",
        qurl_site: "https://r_x.qurl.site",
      });
      const out = await newClient().createQURL({ target_url: "https://example.com" });

      expect(sdk.create).toHaveBeenCalledWith({ target_url: "https://example.com" });
      expect(out.data.qurl_id).toBe("q_x");
      expect(out.data.resource_id).toBe("r_x");
    });

    it("getQURL renames access_tokens → qurls and wraps in { data }", async () => {
      sdk.get.mockResolvedValue({
        resource_id: "r_x",
        status: "active",
        created_at: "t",
        expires_at: "t",
        access_tokens: [{ qurl_id: "q_a", status: "active" }],
      });
      const out = await newClient().getQURL("r_x");

      expect(out.data.qurls).toEqual([{ qurl_id: "q_a", status: "active" }]);
      expect((out.data as { access_tokens?: unknown }).access_tokens).toBeUndefined();
    });

    it("extendQURL delegates to sdk.extend and maps the resource result", async () => {
      // extend changed code paths (old client delegated to updateQURL); confirm
      // it hits sdk.extend and the resource is mapped (access_tokens → qurls).
      sdk.extend.mockResolvedValue({
        resource_id: "r_x",
        status: "active",
        created_at: "t",
        expires_at: "t2",
        access_tokens: [{ qurl_id: "q_a", status: "active" }],
      });
      const out = await newClient().extendQURL("r_x", { extend_by: "24h" });

      expect(sdk.extend).toHaveBeenCalledWith("r_x", { extend_by: "24h" });
      expect(out.data.qurls).toEqual([{ qurl_id: "q_a", status: "active" }]);
      expect((out.data as { access_tokens?: unknown }).access_tokens).toBeUndefined();
    });

    it("listQURLs reshapes the SDK envelope into { data, meta } and maps each item", async () => {
      sdk.list.mockResolvedValue({
        qurls: [{ resource_id: "r_x", access_tokens: [] }],
        next_cursor: "c2",
        has_more: true,
      });
      const out = await newClient().listQURLs({ limit: 10 });

      expect(sdk.list).toHaveBeenCalledWith({ limit: 10 });
      expect(out.data[0].qurls).toEqual([]);
      expect((out.data[0] as { access_tokens?: unknown }).access_tokens).toBeUndefined();
      expect(out.meta).toEqual({ next_cursor: "c2", has_more: true });
    });

    it("batchCreate flattens the SDK output into { data, meta }", async () => {
      sdk.batchCreate.mockResolvedValue({
        succeeded: 1,
        failed: 0,
        results: [{ index: 0, success: true, resource_id: "r_x", qurl_link: "L", qurl_site: "S" }],
        request_id: "req_1",
      });
      const out = await newClient().batchCreate({ items: [{ target_url: "https://example.com" }] });

      expect(out.data.succeeded).toBe(1);
      expect(out.data.failed).toBe(0);
      expect(out.data.results).toHaveLength(1);
      expect(out.meta.request_id).toBe("req_1");
    });

    it("batchCreate surfaces the all-failed (HTTP 400 passthrough) case as failed > 0", async () => {
      // The SDK passes through HTTP 400 (every item failed) as a populated
      // BatchCreateOutput instead of throwing; the adapter must reshape it,
      // not let it surface as a thrown JSON-RPC error.
      sdk.batchCreate.mockResolvedValue({
        succeeded: 0,
        failed: 2,
        results: [
          { index: 0, success: false, error: { code: "invalid_input", message: "non-https" } },
          { index: 1, success: false, error: { code: "invalid_input", message: "non-https" } },
        ],
        request_id: "req_fail",
      });
      const out = await newClient().batchCreate({
        items: [{ target_url: "ftp://a" }, { target_url: "ftp://b" }],
      });

      expect(out.data.succeeded).toBe(0);
      expect(out.data.failed).toBe(2);
      expect(out.data.results).toHaveLength(2);
      expect(out.data.results[0].success).toBe(false);
      expect(out.meta.request_id).toBe("req_fail");
    });

    it("listResourceSessions maps sessions → data", async () => {
      sdk.listResourceSessions.mockResolvedValue({
        sessions: [{ session_id: "s1", qurl_id: "q_a" }],
        request_id: "req_2",
      });
      const out = await newClient().listResourceSessions("r_x");

      expect(out.data).toEqual([{ session_id: "s1", qurl_id: "q_a" }]);
      expect(out.meta).toEqual({ request_id: "req_2" });
    });

    it("terminateAllResourceSessions wraps the count in { data }", async () => {
      sdk.terminateAllResourceSessions.mockResolvedValue({ terminated: 3, request_id: "req_3" });
      const out = await newClient().terminateAllResourceSessions("r_x");

      expect(out.data.terminated).toBe(3);
      expect(out.meta).toEqual({ request_id: "req_3" });
    });

    // The remaining methods are single-`as` passthrough wrappers; one assertion
    // each locks the delegation + `{ data }` wrapping at the adapter layer.

    it("resolveQURL passes the token through and wraps in { data }", async () => {
      sdk.resolve.mockResolvedValue({
        target_url: "https://example.com",
        resource_id: "r_x",
        access_grant: { expires_in: 300, granted_at: "t", src_ip: "1.2.3.4" },
      });
      const out = await newClient().resolveQURL({ access_token: "at_x" });

      expect(sdk.resolve).toHaveBeenCalledWith({ access_token: "at_x" });
      expect(out.data.target_url).toBe("https://example.com");
    });

    it("getQuota wraps the SDK quota in { data }", async () => {
      sdk.getQuota.mockResolvedValue({ plan: "growth", period_start: "a", period_end: "b" });
      const out = await newClient().getQuota();

      expect(out.data.plan).toBe("growth");
    });

    it("mintLink passes the input through and wraps in { data }", async () => {
      sdk.mintLink.mockResolvedValue({ qurl_id: "q_x", qurl_link: "L", expires_at: "t" });
      const out = await newClient().mintLink("r_x", { label: "for Alice" });

      expect(sdk.mintLink).toHaveBeenCalledWith("r_x", { label: "for Alice" });
      expect(out.data.qurl_id).toBe("q_x");
    });

    it("mintLink with no input passes undefined through to the SDK", async () => {
      sdk.mintLink.mockResolvedValue({ qurl_id: "q_x", qurl_link: "L", expires_at: "t" });
      await newClient().mintLink("r_x");
      expect(sdk.mintLink).toHaveBeenCalledWith("r_x", undefined);
    });

    it("updateResource maps the resource result (access_tokens → qurls)", async () => {
      sdk.updateResource.mockResolvedValue({
        resource_id: "r_x",
        status: "active",
        created_at: "t",
        expires_at: "t",
        access_tokens: [],
      });
      const out = await newClient().updateResource("r_x", { description: "d" });

      expect(sdk.updateResource).toHaveBeenCalledWith("r_x", { description: "d" });
      expect(out.data.qurls).toEqual([]);
    });
  });

  describe("method renames", () => {
    it("revokeQurlToken delegates to sdk.revokeResourceQurl", async () => {
      sdk.revokeResourceQurl.mockResolvedValue(undefined);
      await newClient().revokeQurlToken("r_x", "q_y");
      expect(sdk.revokeResourceQurl).toHaveBeenCalledWith("r_x", "q_y");
    });

    it("updateQurlToken delegates to sdk.updateResourceQurl and wraps in { data }", async () => {
      sdk.updateResourceQurl.mockResolvedValue({ qurl_id: "q_y", status: "active" });
      const out = await newClient().updateQurlToken("r_x", "q_y", { label: "renamed" });

      expect(sdk.updateResourceQurl).toHaveBeenCalledWith("r_x", "q_y", { label: "renamed" });
      expect(out.data.qurl_id).toBe("q_y");
    });
  });

  describe("error translation", () => {
    it("maps an SDK NotFoundError to QURLAPIError with statusCode 404 (delete-qurl branch)", async () => {
      sdk.delete.mockRejectedValue(
        new NotFoundError({
          status: 404,
          code: "resource_not_found",
          title: "Not Found",
          detail: "gone",
        }),
      );
      const err = (await newClient()
        .deleteQURL("r_x")
        .catch((e: unknown) => e)) as QURLAPIError;

      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("resource_not_found");
      expect(err.message).toBe("gone");
    });

    it("preserves code and requestId when translating a 403", async () => {
      sdk.create.mockRejectedValue(
        new AuthorizationError({
          status: 403,
          code: "insufficient_scope",
          title: "Forbidden",
          detail: "missing qurl:write",
          request_id: "req_9",
        }),
      );
      const err = (await newClient()
        .createQURL({ target_url: "https://example.com" })
        .catch((e: unknown) => e)) as QURLAPIError;

      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("insufficient_scope");
      expect(err.requestId).toBe("req_9");
    });

    it("translates a transport-level SDK error (NetworkError) to QURLAPIError", async () => {
      // All SDK error subclasses — including transport/timeout failures —
      // extend QURLError, so translateError catches them too (status 0). This
      // matters for delete-qurl, which only swallows QURLAPIError instances.
      sdk.get.mockRejectedValue(new NetworkError("connection refused"));
      const err = (await newClient()
        .getQURL("r_x")
        .catch((e: unknown) => e)) as QURLAPIError;

      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(0);
      expect(err.code).toBe("network_error");
    });
  });
});
