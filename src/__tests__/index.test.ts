import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  createClient: vi.fn(),
  createLocalCliServer: vi.fn(),
  createQurlCli: vi.fn(),
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
  QURLClient: class {
    constructor(config: unknown) {
      mocks.createClient(config);
    }
  },
}));

vi.mock("../server.js", () => ({
  createLocalCliServer: mocks.createLocalCliServer,
  createServer: mocks.createServer,
}));

vi.mock("../qurl-cli.js", () => ({
  QurlCli: class {
    constructor() {
      mocks.createQurlCli();
    }
  },
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
    mocks.createLocalCliServer.mockReturnValue({ connect: mocks.connect });
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
      { uploads: false, email: false },
    );
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.logInfo).toHaveBeenCalledWith("Runtime config loaded.");
    expect(mocks.logInfo).toHaveBeenCalledWith("SMTP is not configured. Missing fields: host");
  });

  it("drives the local qURL CLI when the API key is absent", async () => {
    mocks.loadRuntimeConfig.mockReturnValue({
      defaultQurlApiUrl: "https://api.layerv.ai",
      maxUploadFileDataBytes: 10 * 1024 * 1024,
    });

    await main();

    expect(mocks.createQurlCli).toHaveBeenCalledOnce();
    expect(mocks.createLocalCliServer).toHaveBeenCalledWith(expect.anything(), expect.any(String));
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.inspectSmtpConfig).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "QURL_API_KEY is not set: tools run through the local qURL CLI (qurl), which needs no account.",
    );
  });

  it("keeps the account-key server when the API key is set", async () => {
    await main();

    expect(mocks.createLocalCliServer).not.toHaveBeenCalled();
    expect(mocks.createQurlCli).not.toHaveBeenCalled();
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
