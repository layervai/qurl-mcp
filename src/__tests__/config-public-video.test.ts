import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHttpServerConfig } from "../http-config.js";
import {
  clearRuntimeConfigCache,
  getDefaultConfigPath,
  inspectSmtpConfig,
  loadRuntimeConfig,
} from "../config.js";

describe("public video config", () => {
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalHttpConfigPath = process.env.QURL_MCP_HTTP_CONFIG;
  const originalApiKey = process.env.QURL_API_KEY;
  const originalVideoPath = process.env.QURL_PUBLIC_VIDEO_FILE_PATH;
  const originalVideoTitle = process.env.QURL_PUBLIC_VIDEO_TITLE;
  const originalVideoPagePath = process.env.QURL_PUBLIC_VIDEO_PAGE_PATH;
  let tempDir: string | undefined;

  beforeEach(() => {
    clearRuntimeConfigCache();
    delete process.env.QURL_MCP_CONFIG;
    delete process.env.QURL_MCP_HTTP_CONFIG;
    delete process.env.QURL_API_KEY;
    delete process.env.QURL_PUBLIC_VIDEO_FILE_PATH;
    delete process.env.QURL_PUBLIC_VIDEO_TITLE;
    delete process.env.QURL_PUBLIC_VIDEO_PAGE_PATH;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-video-config-test-"));
  });

  afterEach(() => {
    clearRuntimeConfigCache();
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    process.env.QURL_MCP_HTTP_CONFIG = originalHttpConfigPath;
    process.env.QURL_API_KEY = originalApiKey;
    process.env.QURL_PUBLIC_VIDEO_FILE_PATH = originalVideoPath;
    process.env.QURL_PUBLIC_VIDEO_TITLE = originalVideoTitle;
    process.env.QURL_PUBLIC_VIDEO_PAGE_PATH = originalVideoPagePath;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads public video config from the shared runtime config file", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        publicVideo: {
          title: "Launch Demo",
          pagePath: "/media/video",
          filePath: "/srv/videos/demo.mp4",
        },
      }),
    );

    const config = loadRuntimeConfig(configPath);

    expect(config.publicVideo).toEqual({
      title: "Launch Demo",
      pagePath: "/media/video",
      filePath: "/srv/videos/demo.mp4",
    });
  });

  it("normalizes lexical dot segments in operator-selected video paths", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { filePath: "/srv/videos/../shared/demo.mp4" } }),
    );

    expect(loadRuntimeConfig(configPath).publicVideo?.filePath).toBe("/srv/shared/demo.mp4");
  });

  it("loads public video settings from the distinct HTTP config file", () => {
    const runtimeConfigPath = join(tempDir!, "qurl-mcp.config.json");
    const httpConfigPath = join(tempDir!, "qurl-mcp.http.json");

    writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
      }),
    );
    writeFileSync(
      httpConfigPath,
      JSON.stringify({
        port: 3000,
        host: "0.0.0.0",
        baseUrl: "https://qurl.example.com",
        allowedHosts: ["qurl.example.com"],
        publicVideo: {
          title: "Server Demo",
          pagePath: "show/video",
          filePath: "/srv/videos/demo.mp4",
        },
      }),
    );

    process.env.QURL_MCP_CONFIG = runtimeConfigPath;
    process.env.QURL_MCP_HTTP_CONFIG = httpConfigPath;

    const config = loadHttpServerConfig(httpConfigPath);

    expect(config.publicVideo).toEqual({
      title: "Server Demo",
      pagePath: "/show/video",
      filePath: "/srv/videos/demo.mp4",
    });
  });

  it("does not use QURL_MCP_HTTP_CONFIG as the shared runtime config path", () => {
    const httpConfigPath = join(tempDir!, "qurl-mcp.http.json");
    writeFileSync(
      httpConfigPath,
      JSON.stringify({
        port: 3000,
        host: "127.0.0.1",
        defaultQurlApiUrl: "https://wrong.example.com",
        smtp: { host: "smtp.wrong.example.com" },
      }),
    );
    process.env.QURL_MCP_HTTP_CONFIG = httpConfigPath;

    expect(getDefaultConfigPath()).not.toBe(httpConfigPath);
    const runtime = loadRuntimeConfig();
    expect(runtime.defaultQurlApiUrl).toBe("https://api.layerv.ai");
    expect(runtime.smtp).toBeUndefined();
  });

  it("rejects malformed nested configuration objects", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(configPath, JSON.stringify({ smtp: "not-an-object" }));
    expect(() => loadRuntimeConfig(configPath)).toThrow("smtp must be a JSON object");

    clearRuntimeConfigCache();
    writeFileSync(configPath, JSON.stringify({ publicVideo: [] }));
    expect(() => loadRuntimeConfig(configPath)).toThrow("publicVideo must be a JSON object");
  });

  it("names the offending file when configuration JSON is malformed", () => {
    const configPath = join(tempDir!, "broken-config.json");
    writeFileSync(configPath, '{"smtp":');

    expect(() => loadRuntimeConfig(configPath)).toThrow(configPath);
  });

  it("rejects invalid SMTP quota values instead of silently using defaults", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          maxRecipientsPerMessage: "invalid",
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow(
      "SMTP maxRecipientsPerMessage must be a positive integer",
    );
  });

  it("rejects an implicit-TLS SMTP port configured without secure mode", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 465,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("port 465 requires smtp.secure to be true");
  });

  it.skipIf(process.platform === "win32")(
    "warns when a config-file SMTP password is readable by group or others",
    () => {
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: false,
            username: "mailer",
            password: "secret",
            fromEmail: "noreply@example.com",
            allowedRecipientDomains: ["example.com"],
          },
        }),
      );
      chmodSync(configPath, 0o644);

      expect(inspectSmtpConfig(configPath).securityWarnings).toHaveLength(1);
      chmodSync(configPath, 0o600);
      clearRuntimeConfigCache();
      expect(inspectSmtpConfig(configPath).securityWarnings).toEqual([]);
    },
  );

  it("warns when complete SMTP credentials lack a recipient allowlist", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
      { mode: 0o600 },
    );

    expect(inspectSmtpConfig(configPath).securityWarnings).toContainEqual(
      expect.stringContaining("fail-closed"),
    );
  });

  it.each([
    ["host", "smtp.example.com\r\nattacker.example.com", "SMTP host"],
    ["host", "smtp_example.com", "SMTP host"],
    ["host", `${"a".repeat(64)}.example.com`, "SMTP host"],
    ["host", "-smtp.example.com", "SMTP host"],
    ["username", "mailer\nadmin", "SMTP username"],
    ["username", "u".repeat(321), "SMTP username"],
    ["password", "secret\r\nnext", "SMTP password"],
    ["password", "p".repeat(4097), "SMTP password"],
  ])("rejects malformed SMTP %s values", (field, value, message) => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          [field]: value,
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow(message);
  });

  it("rejects a present but malformed SMTP secure value", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: "tru",
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("SMTP secure must be true or false");
  });

  it("rejects pathological SMTP recipient allowlists", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          allowedRecipients: Array.from(
            { length: 1_001 },
            (_, index) => `user-${index}@example.com`,
          ),
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("at most 1000 entries");
  });

  it("allows environment variables to override shared public video config", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        publicVideo: {
          title: "Config Video",
          pagePath: "/media/video",
          filePath: "/srv/videos/config.mp4",
        },
      }),
    );

    process.env.QURL_PUBLIC_VIDEO_FILE_PATH = "/srv/videos/env.mp4";
    process.env.QURL_PUBLIC_VIDEO_TITLE = "Env Video";
    process.env.QURL_PUBLIC_VIDEO_PAGE_PATH = "public/watch";

    const config = loadRuntimeConfig(configPath);

    expect(config.publicVideo).toEqual({
      title: "Env Video",
      pagePath: "/public/watch",
      filePath: "/srv/videos/env.mp4",
    });
  });

  it("falls back to the configured video path when the environment value is empty", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { filePath: "/srv/videos/config.mp4" } }),
    );
    process.env.QURL_PUBLIC_VIDEO_FILE_PATH = "   ";

    expect(loadRuntimeConfig(configPath).publicVideo?.filePath).toBe("/srv/videos/config.mp4");
  });

  it("rejects public video paths that collide with protocol routes", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { pagePath: "/mcp", filePath: "/srv/video.mp4" } }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("non-reserved absolute URL path");

    clearRuntimeConfigCache();
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { pagePath: "/media/../etc", filePath: "/srv/video.mp4" } }),
    );
    expect(() => loadRuntimeConfig(configPath)).toThrow("non-reserved absolute URL path");

    clearRuntimeConfigCache();
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { pagePath: "/media//video", filePath: "/srv/video.mp4" } }),
    );
    expect(() => loadRuntimeConfig(configPath)).toThrow("non-reserved absolute URL path");
  });

  it("bounds the public video title", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        publicVideo: {
          title: "x".repeat(201),
          pagePath: "/media/video",
          filePath: "/srv/video.mp4",
        },
      }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("title must be at most 200 characters");
  });

  it("requires an absolute public video file path", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { pagePath: "/media/video", filePath: "video.mp4" } }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("must be an absolute filesystem path");
  });

  it("requires the configured public video to use the advertised MP4 format", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ publicVideo: { pagePath: "/media/video", filePath: "/srv/video.webm" } }),
    );

    expect(() => loadRuntimeConfig(configPath)).toThrow("must reference an MP4 file");
  });

  it("loads the qurl API key only from the environment", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
      }),
    );

    process.env.QURL_API_KEY = "env-key";

    const config = loadRuntimeConfig(configPath);

    expect(config.qurlApiKey).toBe("env-key");

    process.env.QURL_API_KEY = "rotated-env-key";
    expect(loadRuntimeConfig(configPath).qurlApiKey).toBe("rotated-env-key");
  });

  it("reloads runtime configuration when the config file changes", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://first.example.com" }));
    expect(loadRuntimeConfig(configPath).defaultQurlApiUrl).toBe("https://first.example.com");

    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://updated.example.com" }));
    expect(loadRuntimeConfig(configPath).defaultQurlApiUrl).toBe("https://updated.example.com");
  });

  it("bounds upload memory and validates service URLs without breaking internal HTTP APIs", () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(configPath, JSON.stringify({ maxUploadFileDataBytes: "101mb" }));
    expect(() => loadRuntimeConfig(configPath)).toThrow("must not exceed 100mb");

    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "http://api.example.com" }));
    expect(() => loadRuntimeConfig(configPath)).toThrow("must use HTTPS");
    clearRuntimeConfigCache();

    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "http://127.0.0.1:8080" }));
    expect(loadRuntimeConfig(configPath).defaultQurlApiUrl).toBe("http://127.0.0.1:8080");
    clearRuntimeConfigCache();

    writeFileSync(
      configPath,
      JSON.stringify({ defaultQurlConnectorUrl: "http://connector.example.com" }),
    );
    expect(() => loadRuntimeConfig(configPath)).toThrow("must use HTTPS");
    clearRuntimeConfigCache();

    writeFileSync(
      configPath,
      JSON.stringify({ defaultQurlConnectorUrl: "https://user:pass@connector.example.com" }),
    );
    expect(() => loadRuntimeConfig(configPath)).toThrow("must not contain credentials");
    clearRuntimeConfigCache();

    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.example.com?q=1" }));
    expect(() => loadRuntimeConfig(configPath)).toThrow("a query");
    clearRuntimeConfigCache();

    writeFileSync(
      configPath,
      JSON.stringify({ defaultQurlApiUrl: "https://api.example.com/#fragment" }),
    );
    expect(() => loadRuntimeConfig(configPath)).toThrow("a fragment");
    clearRuntimeConfigCache();

    for (const field of ["defaultQurlApiUrl", "defaultQurlConnectorUrl"] as const) {
      writeFileSync(configPath, JSON.stringify({ [field]: { unexpected: true } }));
      expect(() => loadRuntimeConfig(configPath)).toThrow(
        "Configuration string fields must be strings",
      );
      clearRuntimeConfigCache();
    }
  });
});
