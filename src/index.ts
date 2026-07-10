#!/usr/bin/env node

import { createRequire } from "node:module";
import { formatErrorForLog, installTimestampedConsole, logInfo } from "./logging.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MISSING_API_KEY_MESSAGE, QURLClient } from "./client.js";
import { getDefaultConfigPath, inspectSmtpConfig, loadRuntimeConfig } from "./config.js";
import { createServer } from "./server.js";

installTimestampedConsole();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

async function main(): Promise<void> {
  try {
    const runtimeConfigPath = getDefaultConfigPath();
    const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
    const apiKey = runtimeConfig.qurlApiKey ?? "";
    if (!apiKey) {
      console.error(`Warning: ${MISSING_API_KEY_MESSAGE}`);
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
    const server = createServer(client, version, "stdio", runtimeConfig.maxUploadFileDataBytes);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(`qURL MCP startup failed (${formatErrorForLog(error)})`);
    process.exitCode = 1;
  }
}

await main();
