import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const MCP_CLIENT_PRODUCT = `qurl-mcp/${version}`;
