#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BINARY_PATH="${QURL_CONNECTOR_BINARY:-${QURL_CLI_MCP_GATEWAY_BINARY:-${SCRIPT_DIR}/qurl-connector}}"
CONFIG_PATH="${QURL_CONNECTOR_CONFIG:-${QURL_CLI_MCP_GATEWAY_CONFIG:-${SCRIPT_DIR}/qurl-connector.json}}"
GO_BIN="${GO_BIN:-go}"

if [[ "${QURL_CONNECTOR_SKIP_BUILD:-${QURL_CLI_MCP_GATEWAY_SKIP_BUILD:-0}}" != "1" ]]; then
  echo "[qurl-connector] building ${BINARY_PATH}" >&2
  cd -- "${SCRIPT_DIR}"
  "${GO_BIN}" build -trimpath -o "${BINARY_PATH}" ./cmd
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "config file not found: ${CONFIG_PATH}" >&2
  exit 1
fi

echo "[qurl-connector] starting with ${CONFIG_PATH}" >&2
exec env QURL_CONNECTOR_CONFIG="${CONFIG_PATH}" "${BINARY_PATH}" "$@"
