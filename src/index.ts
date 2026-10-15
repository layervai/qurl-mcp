#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { formatErrorForLog, installTimestampedConsole, logInfo } from "./logging.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QURLClient } from "./client.js";
import { getDefaultConfigPath, inspectSmtpConfig, loadRuntimeConfig } from "./config.js";
import { QurlCli } from "./qurl-cli.js";
import { createLocalCliServer, createServer } from "./server.js";

installTimestampedConsole();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function main(): Promise<void> {
  try {
    const runtimeConfigPath = getDefaultConfigPath();
    const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
    const apiKey = runtimeConfig.qurlApiKey ?? "";
    if (!apiKey) {
      // No account key: drive the locally installed qURL CLI, which publishes
      // without an account. The CLI is looked up per tool call, so a missing
      // CLI becomes an install instruction in the tool result, not a startup
      // failure.
      logInfo(
        "QURL_API_KEY is not set: tools run through the local qURL CLI (qurl), which needs no account.",
      );
      await createLocalCliServer(new QurlCli(), version).connect(new StdioServerTransport());
      return;
    }
    const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
    logInfo("Runtime config loaded.");
    if (smtpInspection.enabled) {
      logInfo("SMTP is configured.");
    } else {
      logInfo(
        `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
      );
    }
    for (const warning of smtpInspection.securityWarnings) console.warn(`Warning: ${warning}`);

    const client = new QURLClient({ apiKey, baseURL: runtimeConfig.defaultQurlApiUrl });
    logInfo(
      runtimeConfig.defaultQurlConnectorUrl
        ? "Uploads are configured."
        : "Uploads are disabled: QURL_CONNECTOR_URL is not configured.",
    );
    const server = createServer(client, version, "stdio", runtimeConfig.maxUploadFileDataBytes, {
      uploads: Boolean(runtimeConfig.defaultQurlConnectorUrl),
      email: Boolean(runtimeConfig.smtp),
    });
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(`qURL MCP startup failed (${formatErrorForLog(error)})`);
    process.exitCode = 1;
  }
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) await main();
