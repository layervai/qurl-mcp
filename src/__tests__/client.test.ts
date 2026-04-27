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

  describe("missing apiKey guard", () => {
    // Locks in the contract: when QURL_API_KEY is unset (introspection-only
    // mode), every API call must throw a typed missing_api_key error before
    // any network request is issued. Removing this guard would silently fall
    // through to a 401 from the server, masking the configuration problem.
    it("throws missing_api_key with statusCode 0 when apiKey is empty", async () => {
      const noKeyClient = new QURLClient({
        apiKey: "",
        baseURL: "https://api.test.com",
      });
      const mock = vi.fn();
      vi.stubGlobal("fetch", mock);

      await expect(noKeyClient.getQuota()).rejects.toMatchObject({
        name: "QURLAPIError",
        code: "missing_api_key",
        statusCode: 0,
      });
      expect(mock).not.toHaveBeenCalled();
    });

    it("throws missing_api_key for every API method", async () => {
      const noKeyClient = new QURLClient({
        apiKey: "",
        baseURL: "https://api.test.com",
      });
      vi.stubGlobal("fetch", vi.fn());

      const calls: Array<() => Promise<unknown>> = [
        () => noKeyClient.createQURL({ target_url: "https://example.com" }),
        () => noKeyClient.getQURL("r_x"),
        () => noKeyClient.listQURLs(),
        () => noKeyClient.deleteQURL("r_x"),
        () => noKeyClient.updateQURL("r_x", { extend_by: "1h" }),
        () => noKeyClient.extendQURL("r_x", { extend_by: "1h" }),
        () => noKeyClient.resolveQURL({ access_token: "at_x" }),
        () => noKeyClient.getQuota(),
        () => noKeyClient.mintLink("r_x"),
        () => noKeyClient.batchCreate({ items: [{ target_url: "https://example.com" }] }),
      ];

      for (const call of calls) {
        await expect(call()).rejects.toBeInstanceOf(QURLAPIError);
      }
    });
  });

  describe("request headers", () => {
    it("sends Authorization bearer header on all requests", async () => {
      const mock = stubFetch({ data: {} });

      await client.getQuota();

      expect(mock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        }),
      );
    });

    it("sends Content-Type only when request has a body", async () => {
      const mock = stubFetch({ data: {} });

      await client.createQURL({ target_url: "https://example.com" });

      expect(mock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("omits Content-Type on GET requests", async () => {
      const mock = stubFetch({ data: {} });

      await client.getQuota();

      const headers = (mock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers).not.toHaveProperty("Content-Type");
    });
  });

  describe("error handling", () => {
    it("throws QURLAPIError on 4xx response with RFC 7807 format", async () => {
      stubFetch(
        {
          error: {
            type: "https://api.qurl.link/problems/not_found",
            title: "Resource Not Found",
            status: 404,
            detail: "QURL not found",
            instance: "/v1/qurls/r_nonexistent",
            code: "not_found",
          },
          meta: { request_id: "req_abc123" },
        },
        404,
      );

      const err = await client.getQURL("r_nonexistent").catch((e: unknown) => e) as QURLAPIError;
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("QURL not found");
      expect(err.type).toBe("https://api.qurl.link/problems/not_found");
      expect(err.instance).toBe("/v1/qurls/r_nonexistent");
      expect(err.requestId).toBe("req_abc123");
    });

    it("throws QURLAPIError on 5xx response", async () => {
      stubFetch(
        {
          error: {
            type: "https://api.qurl.link/problems/internal_error",
            title: "Internal Error",
            status: 500,
            detail: "Server error",
            code: "internal_error",
          },
        },
        500,
      );

      const err = await client.getQuota().catch((e: unknown) => e) as QURLAPIError;
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe("internal_error");
      expect(err.message).toBe("Server error");
    });

    it("falls back to error.message for legacy error format", async () => {
      stubFetch(
        { error: { code: "not_found", message: "Resource not found" } },
        404,
      );

      const err = await client.getQURL("r_nonexistent").catch((e: unknown) => e) as QURLAPIError;
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("Resource not found");
      // RFC 7807 fields are not present in legacy format
      expect(err.type).toBeUndefined();
      expect(err.instance).toBeUndefined();
      expect(err.requestId).toBeUndefined();
    });

    it("falls back to error.title when detail is missing", async () => {
      stubFetch(
        {
          error: {
            type: "https://api.qurl.link/problems/forbidden",
            title: "Forbidden",
            status: 403,
            code: "forbidden",
          },
        },
        403,
      );

      const err = await client.getQuota().catch((e: unknown) => e) as QURLAPIError;
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err.message).toBe("Forbidden");
      expect(err.type).toBe("https://api.qurl.link/problems/forbidden");
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

    it("handles empty 2xx response body (204 No Content)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(""),
      }));

      const result = await client.deleteQURL("r_abc");
      expect(result).toBeUndefined();
    });

    it("throws on empty non-2xx response body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve(""),
      }));

      const err = await client.getQuota().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QURLAPIError);
      expect(err).toMatchObject({
        statusCode: 502,
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

    it("QURLAPIError stores optional RFC 7807 fields", () => {
      const err = new QURLAPIError(
        400,
        "invalid_request",
        "Bad request",
        "https://api.qurl.link/problems/invalid_request",
        "/v1/qurls",
        "req_123",
      );
      expect(err.type).toBe("https://api.qurl.link/problems/invalid_request");
      expect(err.instance).toBe("/v1/qurls");
      expect(err.requestId).toBe("req_123");
    });
  });

  describe("createQURL", () => {
    it("sends POST to /v1/qurls with body", async () => {
      const mockData = {
        data: {
          qurl_id: "q_3a7f2c8e91b",
          resource_id: "r_abc123",
          qurl_link: "https://qurl.link/at_token",
          qurl_site: "https://q_3a7f2c8e91b.qurl.site",
          expires_at: "2026-04-01T00:00:00Z",
        },
      };
      const mock = stubFetch(mockData);

      const input = {
        target_url: "https://example.com",
        label: "Test link",
        expires_in: "24h",
        one_time_use: false,
        max_sessions: 3,
      };
      const result = await client.createQURL(input);

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(input),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("sends POST without optional fields", async () => {
      const mock = stubFetch({ data: { qurl_id: "q_abc", resource_id: "r_abc" } });

      await client.createQURL({ target_url: "https://example.com" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ target_url: "https://example.com" }),
        }),
      );
    });

    it("sends access_policy in body", async () => {
      const mock = stubFetch({ data: { qurl_id: "q_abc", resource_id: "r_abc" } });

      const input = {
        target_url: "https://example.com",
        access_policy: {
          ip_allowlist: ["192.168.1.0/24"],
          geo_allowlist: ["US"],
          ai_agent_policy: { deny_categories: ["gptbot"] },
        },
      };
      await client.createQURL(input);

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls",
        expect.objectContaining({
          body: JSON.stringify(input),
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

    it("sends limit=0 as query param", async () => {
      // The MCP tool schema rejects limit < 1 at the validation layer.
      // This test covers the client method in isolation — an embedder that
      // uses QURLClient directly (not via the MCP tool) gets the 0 through.
      const mock = stubFetch({ data: [], meta: { has_more: false } });

      await client.listQURLs({ limit: 0 });

      const calledUrl = mock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("limit=0");
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

    it("sends filter query params", async () => {
      const mock = stubFetch({ data: [], meta: { has_more: false } });

      await client.listQURLs({
        status: "active",
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-12-31T23:59:59Z",
        expires_before: "2026-06-01T00:00:00Z",
        expires_after: "2026-03-01T00:00:00Z",
        sort: "created_at:desc",
        q: "dashboard",
      });

      const calledUrl = mock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("status=active");
      expect(calledUrl).toContain("created_after=2026-01-01T00%3A00%3A00Z");
      expect(calledUrl).toContain("created_before=2026-12-31T23%3A59%3A59Z");
      expect(calledUrl).toContain("expires_before=2026-06-01T00%3A00%3A00Z");
      expect(calledUrl).toContain("expires_after=2026-03-01T00%3A00%3A00Z");
      expect(calledUrl).toContain("sort=created_at%3Adesc");
      expect(calledUrl).toContain("q=dashboard");
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

  describe("updateQURL", () => {
    it("sends PATCH to /v1/qurls/:id with extend_by body", async () => {
      const mockData = { data: { resource_id: "r_abc", expires_at: "2026-04-01T00:00:00Z" } };
      const mock = stubFetch(mockData);

      const result = await client.updateQURL("r_abc", { extend_by: "48h" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ extend_by: "48h" }),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("sends PATCH with expires_at", async () => {
      const mockData = { data: { resource_id: "r_abc", expires_at: "2026-04-01T00:00:00Z" } };
      const mock = stubFetch(mockData);

      await client.updateQURL("r_abc", { expires_at: "2026-04-01T00:00:00Z" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc",
        expect.objectContaining({
          body: JSON.stringify({ expires_at: "2026-04-01T00:00:00Z" }),
        }),
      );
    });

    it("sends PATCH with tags and description", async () => {
      const mock = stubFetch({ data: { resource_id: "r_abc" } });

      await client.updateQURL("r_abc", {
        tags: ["prod", "api"],
        description: "Updated description",
      });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc",
        expect.objectContaining({
          body: JSON.stringify({ tags: ["prod", "api"], description: "Updated description" }),
        }),
      );
    });
  });

  describe("resolveQURL", () => {
    it("sends POST to /v1/resolve with access_token", async () => {
      const mockData = {
        data: {
          target_url: "https://example.com",
          resource_id: "r_abc",
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
          plan: "growth",
          period_start: "2026-03-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
          rate_limits: {
            create_per_minute: 200,
            create_per_hour: 10000,
            list_per_minute: 120,
            resolve_per_minute: 300,
            max_active_qurls: 1000,
            max_tokens_per_qurl: 50,
            max_expiry_seconds: 2592000,
          },
          usage: {
            qurls_created: 150,
            active_qurls: 45,
            active_qurls_percent: 0.45,
            total_accesses: 1250,
          },
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

  describe("mintLink", () => {
    it("sends POST to /v1/qurls/:id/mint_link", async () => {
      const mockData = {
        data: {
          qurl_link: "https://qurl.link/at_newtoken",
          expires_at: "2026-04-01T00:00:00Z",
        },
      };
      const mock = stubFetch(mockData);

      const result = await client.mintLink("r_abc123", { label: "Alice" });

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc123/mint_link",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ label: "Alice" }),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("sends no body when no input provided", async () => {
      const mock = stubFetch({ data: { qurl_link: "https://qurl.link/at_x" } });

      await client.mintLink("r_abc123");

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc123/mint_link",
        expect.objectContaining({
          body: undefined,
        }),
      );
      // Content-Type should be omitted when there's no body.
      const headers = (mock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers).not.toHaveProperty("Content-Type");
    });

    it("URL-encodes the resource ID", async () => {
      const mock = stubFetch({ data: {} });

      await client.mintLink("r_abc/def");

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/r_abc%2Fdef/mint_link",
        expect.any(Object),
      );
    });
  });

  describe("batchCreate", () => {
    it("sends POST to /v1/qurls/batch with items", async () => {
      const mockData = {
        data: {
          succeeded: 2,
          failed: 0,
          results: [
            { index: 0, success: true, resource_id: "r_abc", qurl_link: "https://qurl.link/at_1" },
            { index: 1, success: true, resource_id: "r_def", qurl_link: "https://qurl.link/at_2" },
          ],
        },
        meta: { request_id: "req_batch1" },
      };
      const mock = stubFetch(mockData);

      const input = {
        items: [
          { target_url: "https://app1.example.com", expires_in: "7d" },
          { target_url: "https://app2.example.com", expires_in: "24h" },
        ],
      };
      const result = await client.batchCreate(input);

      expect(mock).toHaveBeenCalledWith(
        "https://api.test.com/v1/qurls/batch",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(input),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("returns partial success results", async () => {
      const mockData = {
        data: {
          succeeded: 1,
          failed: 1,
          results: [
            { index: 0, success: true, resource_id: "r_abc", qurl_link: "https://qurl.link/at_1" },
            { index: 1, success: false, error: { code: "invalid_target_url", message: "Invalid URL" } },
          ],
        },
        meta: { request_id: "req_batch2" },
      };
      stubFetch(mockData, 207);

      const result = await client.batchCreate({
        items: [
          { target_url: "https://valid.example.com" },
          { target_url: "not-a-url" },
        ],
      });

      expect(result.data.succeeded).toBe(1);
      expect(result.data.failed).toBe(1);
      expect(result.data.results[1].error?.code).toBe("invalid_target_url");
    });

    it("passes through the structured body on HTTP 400 (all items failed)", async () => {
      // When every batch item fails validation the API returns 400 with a
      // BatchCreateResponse body, not an error envelope. The client must
      // surface the per-item errors instead of throwing a generic "HTTP 400".
      const mockData = {
        data: {
          succeeded: 0,
          failed: 2,
          results: [
            {
              index: 0,
              success: false,
              error: { code: "invalid_input", message: "items[0]: target_url must be HTTPS" },
            },
            {
              index: 1,
              success: false,
              error: { code: "invalid_input", message: "items[1]: target_url must be HTTPS" },
            },
          ],
        },
        meta: { request_id: "req_batch_fail" },
      };
      stubFetch(mockData, 400);

      const result = await client.batchCreate({
        items: [
          { target_url: "http://insecure1.example.com" },
          { target_url: "http://insecure2.example.com" },
        ],
      });

      expect(result.data.failed).toBe(2);
      expect(result.data.succeeded).toBe(0);
      expect(result.data.results[0].error?.message).toContain("target_url must be HTTPS");
      expect(result.data.results[1].error?.message).toContain("target_url must be HTTPS");
      expect(result.meta.request_id).toBe("req_batch_fail");
    });

    it("still throws on non-400 batch errors (e.g., 401, 429, 5xx)", async () => {
      stubFetch(
        {
          error: {
            type: "https://api.qurl.link/problems/unauthorized",
            title: "Unauthorized",
            status: 401,
            code: "unauthorized",
          },
        },
        401,
      );

      await expect(
        client.batchCreate({ items: [{ target_url: "https://example.com" }] }),
      ).rejects.toThrow(QURLAPIError);
    });
  });
});
