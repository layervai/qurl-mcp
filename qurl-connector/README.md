# qurl-connector

qURL Connector is an HTTP gateway for CLI and MCP clients. A new MCP session
supplies a CRID, then the connector creates a short-lived qURL authorization,
opens its portal, and proxies the MCP request. Later tool calls, SSE reconnects,
and `DELETE` requests reuse the portal registered for the `Mcp-Session-Id`.

The connector uses the qURL SDK for qv2 credential links and the qURL
`POST /v1/resolve` API for `at_` access-token links. It does not use OpenNHP
knocks.

See [USAGE.md](USAGE.md) for installation, configuration, client examples, and
troubleshooting. [ARCHITECTURE.md](ARCHITECTURE.md) describes the session and
authorization boundaries.

## Configuration

The default configuration file is `qurl-connector.json`. Override its location
with `QURL_CONNECTOR_CONFIG`; `QURL_CLI_MCP_GATEWAY_CONFIG` remains supported
for existing deployments during migration.

The `share` API requires a qURL credential with resource-share permission:

```json
{
  "apiBaseUrl": "https://api.layerv.ai",
  "apiKey": "lv_live_..."
}
```

For qv2 links, configure `deploymentPath` in the JSON file or set
`QURL_DEPLOYMENT`. Relative deployment paths are resolved from the configuration
file directory. The included `qurl-deployment.xyz.json` is for the current
sandbox issuer and relay configuration.

`allowedLinkHosts` defaults to `qurl.link`. Add any test or private-deployment
hosts explicitly.

## Requests

Provide the CRID with `X-MCP-CRID`; `X-QURL-CRID`, `X-CRID`, `CRID`, and the
`crid` query parameter are also accepted. The connector removes CRID headers
and the `crid` query parameter before proxying upstream.

```bash
curl -X POST 'http://127.0.0.1:3100/mcp' \
  -H 'Content-Type: application/json' \
  -H 'X-MCP-CRID: <CRID>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Run

```bash
./build-and-start.sh
```

The health endpoint is `GET /healthz`.
