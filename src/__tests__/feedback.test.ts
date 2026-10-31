import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalCliServer, createServer as createMcpServer } from "../server.js";
import { makeMockClient } from "./helpers.js";
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeedbackRoute } from "../http-feedback.js";
import { deliverFeedback, feedbackWebhookUrl, FEEDBACK_URL } from "../services/feedback.js";
import { submitFeedbackTool } from "../tools/submit-feedback.js";

const webhook = "https://hooks.slack.com/services/TEST/CHANNEL/secret";
const report = {
  category: "bug",
  message: "Expected a link; got an unclear error.",
  tool_name: "publish_crid",
};
const realFetch = globalThis.fetch;
let server: Server | undefined;
let tick = Date.now();
beforeEach(() => {
  tick += 60_000;
  vi.spyOn(Date, "now").mockReturnValue(tick);
  vi.stubEnv("MCP_FEEDBACK_SLACK_WEBHOOK_URL", webhook);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function start(withVerifiedSubjects = false) {
  const app = express();
  const toolLimiter = registerFeedbackRoute(app, "https://mcp.connector.layerv.ai");
  if (withVerifiedSubjects)
    app.post(
      "/mcp",
      express.json(),
      (req, _res, next) => {
        // Production obtains this context only from the existing verified OAuth middleware.
        req.auth = {
          token: "fixture",
          clientId: "fixture",
          scopes: [],
          extra: { subject: req.headers["x-test-subject"] },
        };
        next();
      },
      toolLimiter,
      (_req, res) => {
        res.json({ accepted: true });
      },
    );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}/feedback`;
}
describe("feedback delivery", () => {
  it("posts plain text to the operator channel and returns a receipt only after acknowledgement", async () => {
    vi.stubEnv("QURL_API_KEY", "test-account-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const receipt = await deliverFeedback({
      ...report,
      message:
        "<!channel> test-account-secret lv_live_secret Bearer abc https://qurl.link/private alice@example.com",
    });
    expect(receipt.status).toBe("sent_for_human_review");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(webhook);
    expect(init.redirect).toBe("error");
    const body = JSON.parse(init.body);
    expect(body.blocks[0].text.type).toBe("plain_text");
    expect(body.blocks[0].text.text).toContain(receipt.feedback_id);
    for (const secret of [
      "test-account-secret",
      "lv_live_secret",
      "Bearer abc",
      "https://qurl.link/private",
      "alice@example.com",
    ])
      expect(init.body).not.toContain(secret);
    expect(init.headers.authorization).toBeUndefined();
  });
  it.each([
    new Response("invalid_payload", { status: 400 }),
    new Response("not ok"),
    new Response("x".repeat(100)),
  ])("never confirms Slack rejection or malformed acknowledgement", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(deliverFeedback(report)).rejects.toThrow("could not be confirmed");
  });
  it("accepts a chunked Slack acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new globalThis.ReadableStream({
            start(controller) {
              controller.enqueue(new globalThis.TextEncoder().encode("o"));
              controller.enqueue(new globalThis.TextEncoder().encode("k"));
              controller.close();
            },
          }),
        ),
      ),
    );
    expect((await deliverFeedback(report)).status).toBe("sent_for_human_review");
  });
  it("logs only bounded Slack status on delivery failure", async () => {
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no_service", { status: 404 })));
    await expect(deliverFeedback(report)).rejects.toThrow("could not be confirmed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    expect(JSON.stringify(log.mock.calls)).not.toContain(webhook);
    expect(JSON.stringify(log.mock.calls)).not.toContain(report.message);
  });
  it("bounds parallel submissions across tool sessions and the public route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.allSettled([deliverFeedback(report), deliverFeedback(report)]);
    expect(results.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("bounds total Slack attempts to 1000 per process per UTC hour", async () => {
    tick = Math.ceil(tick / 3_600_000) * 3_600_000;
    const mock = vi.fn().mockImplementation(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", mock);
    for (let i = 0; i < 1000; i++) {
      tick += 2_000;
      vi.mocked(Date.now).mockReturnValue(tick);
      await deliverFeedback(report);
    }
    tick += 2_000;
    vi.mocked(Date.now).mockReturnValue(tick);
    await expect(deliverFeedback(report)).rejects.toThrow("hourly report limit");
    expect(mock).toHaveBeenCalledTimes(1000);
    tick += 3_600_000;
    vi.mocked(Date.now).mockReturnValue(tick);
    expect((await deliverFeedback(report)).status).toBe("sent_for_human_review");
  });
  it("fails closed when unconfigured and rejects a non-Slack destination", async () => {
    vi.stubEnv("MCP_FEEDBACK_SLACK_WEBHOOK_URL", "");
    await expect(deliverFeedback(report)).rejects.toThrow("not configured");
    vi.stubEnv("MCP_FEEDBACK_SLACK_WEBHOOK_URL", "https://internal.example/secret");
    expect(feedbackWebhookUrl).toThrow("must be a Slack");
  });
  it("does not leak upstream errors or the webhook secret", async () => {
    const mock = vi.fn().mockRejectedValue(new Error(webhook));
    vi.stubGlobal("fetch", mock);
    const tool = submitFeedbackTool(undefined, { mode: "http" });
    const result = await tool.handler(report);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(webhook);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("local agents send only the explicit report to LayerV, without account credentials", async () => {
    const receipt = {
      feedback_id: "c572d71e-fb5b-4f38-a632-5f697252856d",
      status: "sent_for_human_review",
    };
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
    vi.stubGlobal("fetch", mock);
    expect((await submitFeedbackTool().handler(report)).structuredContent).toEqual(receipt);
    expect(mock.mock.calls[0][0]).toBe(FEEDBACK_URL);
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(report);
    expect(mock.mock.calls[0][1].headers).toEqual({ "content-type": "application/json" });
  });
  it.each([429, 503, 400, 413, 415])(
    "reports definite intake rejection %s as not sent",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status })));
      const result = await submitFeedbackTool().handler(report);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("was not sent");
      expect(result.content[0].text).not.toContain("may have arrived");
    },
  );
  it("redacts local secrets before sending feedback to LayerV", async () => {
    vi.stubEnv("QURL_API_KEY", "local-unusual-key");
    const mock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", mock);
    await submitFeedbackTool().handler({
      ...report,
      message: "local-unusual-key alice@example.com https://private.example/path",
    });
    expect(mock.mock.calls[0][1].body).not.toContain("local-unusual-key");
    expect(mock.mock.calls[0][1].body).not.toContain("alice@example.com");
    expect(mock.mock.calls[0][1].body).not.toContain("https://private.example");
  });
  it("rejects invalid reports before sending", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const invalid of [
      { ...report, message: " " },
      { ...report, message: "x".repeat(501) },
      { ...report, secret: "unknown" },
    ])
      expect((await submitFeedbackTool().handler(invalid)).isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });
});
describe("MCP feedback journey", () => {
  it.each(["stdio", "http"] as const)(
    "lists and calls feedback over the real %s MCP schema boundary",
    async (mode) => {
      const url = await start();
      const outbound = vi.fn(async (...[target, init]: Parameters<typeof fetch>) => {
        if (target === FEEDBACK_URL) return realFetch(url, init);
        expect(target).toBe(webhook);
        return new Response("ok");
      });
      vi.stubGlobal("fetch", outbound);
      const mcp =
        mode === "stdio"
          ? createLocalCliServer({ runJson: vi.fn() }, "test")
          : createMcpServer(makeMockClient(), "test", "http");
      const client = new Client({ name: "feedback-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await mcp.connect(b);
        await client.connect(a);
        expect(
          (await client.listTools()).tools.find((tool) => tool.name === "submit_feedback"),
        ).toBeDefined();
        const result = await client.callTool({ name: "submit_feedback", arguments: report });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ status: "sent_for_human_review" });
        expect(outbound).toHaveBeenCalledTimes(mode === "stdio" ? 2 : 1);
      } finally {
        await client.close();
        await mcp.close();
      }
    },
  );
});
describe("POST /feedback", () => {
  it("runs an anonymous local-agent report through the hosted intake to mocked Slack", async () => {
    const url = await start();
    const mock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mock);
    const response = await realFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).status).toBe("sent_for_human_review");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid origins, oversized bodies, unknown fields, and malformed JSON before Slack", async () => {
    const url = await start();
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const [body, extraHeaders, status] of [
      [JSON.stringify(report), { origin: "https://evil.example" }, 403],
      [JSON.stringify(report), { "content-type": "text/plain" }, 415],
      [JSON.stringify({ ...report, message: "x".repeat(5000) }), {}, 413],
      [JSON.stringify({ ...report, credentials: "private" }), {}, 400],
      ["{", {}, 400],
    ] as const) {
      const response = await realFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body,
      });
      expect(response.status).toBe(status);
      await response.body?.cancel();
    }
    expect(mock).not.toHaveBeenCalled();
  });
  it("keeps verified OAuth subjects separate behind one vendor egress IP", async () => {
    const url = (await start(true)).replace("/feedback", "/mcp");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "submit_feedback", arguments: report },
    });
    for (let i = 0; i < 11; i++) {
      const response = await realFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-subject": "account-a" },
        body,
      });
      expect(response.status).toBe(i === 10 ? 429 : 200);
      await response.body?.cancel();
    }
    const other = await realFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-subject": "account-b" },
      body,
    });
    expect(other.status).toBe(200);
    await other.body?.cancel();
  });
  it("limits anonymous submissions per source IP, even when Slack is disabled", async () => {
    vi.stubEnv("MCP_FEEDBACK_SLACK_WEBHOOK_URL", "");
    const url = await start();
    for (let i = 0; i < 101; i++) {
      const response = await realFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      expect(response.status).toBe(i === 100 ? 429 : 503);
      await response.body?.cancel();
    }
  });
});
