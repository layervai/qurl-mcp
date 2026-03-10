import { describe, it, expect, vi, beforeEach } from "vitest";
import { QURLClient, QURLAPIError } from "../client.js";

function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("QURLClient", () => {
  let client: QURLClient;

  beforeEach(() => {
    client = new QURLClient({
      apiKey: "test-key",
      baseURL: "https://api.test.com",
    });
  });

  describe("constructor", () => {
    it("stores apiKey and baseURL", async () => {
      const customClient = new QURLClient({
        apiKey: "custom-key",
        baseURL: "https://api.example.com",
      });
      const mock = stubFetch({ data: {} });

      await customClient.getQuota();

      expect(mock).toHaveBeenCalledWith(
        "https://api.example.com/v1/quota",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer custom-key",
          }),
        }),
      );
    });

    it("strips trailing slash from baseURL", async () => {
      const customClient = new QURLClient({
        apiKey: "test-key",
        baseURL: "https://api.example.com/",
      });
      const mock = stubFetch({ data: {} });

      await customClient.getQuota();

      expect(mock).toHaveBeenCalledWith(
        "https://api.example.com/v1/quota",
        expect.any(Object),
      );
    });
  });

  describe("request headers", () => {
    it("sends Authorization bearer header and Content-Type", async () => {
      const mock = stubFetch({ data: {} });

      await client.getQuota();

      expect(mock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
        }),
      );
    });
  });

  describe("error handling", () => {
    it("throws QURLAPIError on 4xx response", async () => {
      stubFetch(
        { error: { code: "not_found", message: "Resource not found" } },
        404,
      );

      const err = await client.getQURL("r_nonexistent").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 404,
        code: "not_found",
        message: "Resource not found",
      });
    });

    it("throws QURLAPIError on 5xx response", async () => {
      stubFetch(
        { error: { code: "internal_error", message: "Server error" } },
        500,
      );

      const err = await client.getQuota().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 500,
        code: "internal_error",
        message: "Server error",
      });
    });

    it("throws QURLAPIError with defaults when error body has no error field", async () => {
      stubFetch({ some: "data" }, 403);

      const err = await client.getQuota().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 403,
        code: "unknown",
        message: "HTTP 403",
      });
    });

    it("throws QURLAPIError on non-JSON response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("not json at all"),
      }));

      const err = await client.getQuota().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 200,
        code: "parse_error",
      });
    });

    it("truncates long non-JSON response in error message", async () => {
      const longText = "x".repeat(300);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(longText),
      }));

      const err = await client.getQuota().catch((e: unknown) => e) as QURLAPIError;
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.message).toBe("Failed to parse response: " + "x".repeat(200));
    });

    // TODO: client.request() should short-circuit on empty 2xx responses
    // instead of throwing parse_error. Fix in client.ts, then update this test.
    it("throws on empty response body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(""),
      }));

      const err = await client.deleteQURL("r_abc").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 204,
        code: "parse_error",
      });
    });

    it("propagates network-level fetch failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      await expect(client.listQURLs()).rejects.toThrow("fetch failed");
    });

    it("QURLAPIError has correct name property", () => {
      const err = new QURLAPIError(400, "bad_request", "Bad request");
      expect(err.name).toBe("QURLAPIError");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("createQURL", () => {
    it("sends POST to /v1/qurl with body", async () => {
      const mockData = {
        data: {
          resource_id: "r_abc123",
          qurl_link: "https://qurl.link/at_token",
          target_url: "https://example.com",
          status: "active",
        },
      };
      const mock = stubFetch(mockData);

      const input = {
        target_url: "https://example.com",
        description: "Test link",
        expires_in: "24h",
        one_time_use: false,
        max_sessions: 3,
      };
      const result = await client.createQURL(input);

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurl",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(input),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("sends POST without optional fields", async () => {
      const mock = stubFetch({ data: { resource_id: "r_abc" } });

      await client.createQURL({ target_url: "https://example.com" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurl",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ target_url: "https://example.com" }),
        }),
      );
    });
  });

  describe("getQURL", () => {
    it("sends GET to /v1/qurls/:id", async () => {
      const mockData = { data: { resource_id: "r_abc123", status: "active" } };
      const mock = stubFetch(mockData);

      const result = await client.getQURL("r_abc123");

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc123",
        expect.objectContaining({ method: "GET", body: undefined }),
      );
      expect(result).toEqual(mockData);
    });

    it("URL-encodes the resource ID", async () => {
      const mock = stubFetch({ data: {} });

      await client.getQURL("r_abc/def");

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc%2Fdef",
        expect.any(Object),
      );
    });
  });

  describe("listQURLs", () => {
    it("sends GET to /v1/qurls with no query params by default", async () => {
      const mockData = { data: [], meta: { has_more: false } };
      const mock = stubFetch(mockData);

      const result = await client.listQURLs();

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result).toEqual(mockData);
    });

    it("sends limit and cursor as query params", async () => {
      const mock = stubFetch({ data: [], meta: { has_more: false } });

      await client.listQURLs({ limit: 10, cursor: "cur_xyz" });

      const calledUrl = mock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/v1/qurls?");
      expect(calledUrl).toContain("limit=10");
      expect(calledUrl).toContain("cursor=cur_xyz");
    });

    it("sends only limit when cursor is not provided", async () => {
      const mock = stubFetch({ data: [], meta: { has_more: false } });

      await client.listQURLs({ limit: 5 });

      const calledUrl = mock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("limit=5");
      expect(calledUrl).not.toContain("cursor");
    });

    it("sends no query params when input is empty object", async () => {
      const mock = stubFetch({ data: [], meta: { has_more: false } });

      await client.listQURLs({});

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls",
        expect.any(Object),
      );
    });
  });

  describe("deleteQURL", () => {
    it("sends DELETE to /v1/qurls/:id", async () => {
      const mock = stubFetch({});

      await client.deleteQURL("r_abc123");

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc123",
        expect.objectContaining({ method: "DELETE", body: undefined }),
      );
    });

    it("returns void on success", async () => {
      stubFetch({});

      const result = await client.deleteQURL("r_abc123");
      expect(result).toBeUndefined();
    });
  });

  describe("extendQURL", () => {
    it("sends PATCH to /v1/qurls/:id with extend_by body", async () => {
      const mockData = { data: { resource_id: "r_abc", expires_at: "2026-04-01T00:00:00Z" } };
      const mock = stubFetch(mockData);

      const result = await client.extendQURL("r_abc", { extend_by: "48h" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ extend_by: "48h" }),
        }),
      );
      expect(result).toEqual(mockData);
    });
  });

  describe("resolveQURL", () => {
    it("sends POST to /v1/resolve with access_token", async () => {
      const mockData = {
        data: {
          target_url: "https://example.com",
          resource_id: "r_abc",
          session_id: "s_xyz",
          access_grant: {
            expires_in: 300,
            granted_at: "2026-03-09T00:00:00Z",
            src_ip: "1.2.3.4",
          },
        },
      };
      const mock = stubFetch(mockData);

      const result = await client.resolveQURL({ access_token: "at_token123" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/resolve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ access_token: "at_token123" }),
        }),
      );
      expect(result).toEqual(mockData);
    });
  });

  describe("getQuota", () => {
    it("sends GET to /v1/quota", async () => {
      const mockData = {
        data: {
          plan: "pro",
          limits: { max_qurls: 1000 },
          usage: { active_qurls: 42 },
        },
      };
      const mock = stubFetch(mockData);

      const result = await client.getQuota();

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/quota",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result).toEqual(mockData);
    });
  });
});
