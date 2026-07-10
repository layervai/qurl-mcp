import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  createClient: vi.fn(),
  createServer: vi.fn(),
  formatErrorForLog: vi.fn((error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError",
  ),
  inspectSmtpConfig: vi.fn(),
  loadRuntimeConfig: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  formatErrorForLog: mocks.formatErrorForLog,
  installTimestampedConsole: vi.fn(),
  logInfo: mocks.logInfo,
}));

vi.mock("../config.js", () => ({
  getDefaultConfigPath: vi.fn(() => "/tmp/qurl-mcp.config.json"),
  inspectSmtpConfig: mocks.inspectSmtpConfig,
  loadRuntimeConfig: mocks.loadRuntimeConfig,
}));

vi.mock("../client.js", () => ({
  MISSING_API_KEY_MESSAGE: "QURL_API_KEY is not set",
  QURLClient: class {
    constructor(config: unknown) {
      mocks.createClient(config);
    }
  },
}));

vi.mock("../server.js", () => ({
  createServer: mocks.createServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

import { main } from "../index.js";

describe("stdio bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.createServer.mockReturnValue({ connect: mocks.connect });
    mocks.loadRuntimeConfig.mockReturnValue({
      defaultQurlApiUrl: "https://api.layerv.ai",
      maxUploadFileDataBytes: 10 * 1024 * 1024,
      qurlApiKey: "lv_live_bootstrap",
    });
    mocks.inspectSmtpConfig.mockReturnValue({
      enabled: false,
      missingFields: ["host"],
      securityWarnings: [],
    });
  });

  it("loads config, reports SMTP state, and connects the stdio server", async () => {
    await main();

    expect(mocks.createClient).toHaveBeenCalledWith({
      apiKey: "lv_live_bootstrap",
      baseURL: "https://api.layerv.ai",
    });
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "stdio",
      10 * 1024 * 1024,
    );
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.logInfo).toHaveBeenCalledWith("Runtime config loaded.");
    expect(mocks.logInfo).toHaveBeenCalledWith("SMTP is not configured. Missing fields: host");
  });

  it("warns when the API key is absent", async () => {
    mocks.loadRuntimeConfig.mockReturnValue({
      defaultQurlApiUrl: "https://api.layerv.ai",
      maxUploadFileDataBytes: 10 * 1024 * 1024,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await main();

    expect(error).toHaveBeenCalledWith("Warning: QURL_API_KEY is not set");
    expect(mocks.createClient).toHaveBeenCalledWith({
      apiKey: "",
      baseURL: "https://api.layerv.ai",
    });
  });

  it("reports bootstrap failures and sets a failing process status", async () => {
    const originalExitCode = process.exitCode;
    mocks.loadRuntimeConfig.mockImplementation(() => {
      throw new Error("config failed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await main();

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith("qURL MCP startup failed (Error: config failed)");
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
