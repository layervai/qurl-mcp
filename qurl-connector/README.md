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

Start from [`qurl-connector.example.json`](qurl-connector.example.json), save
the copy as `qurl-connector.json`, and replace `apiKey` with a qURL credential
that has resource-share permission. Do not commit the resulting file.

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

Clients may also connect without a CRID when `dynamicCrid` is enabled (the
default). The connector then exposes `qurl_list_tools` and `qurl_call_tool`,
which take the CRID as a tool argument, create the qURL link, and forward the
request to the protected MCP server, plus `qurl_get_link`, which only returns a
qURL access link and also works for protected HTTP services. See
[USAGE.md](USAGE.md#dynamic-crid-mode).

## Run

```bash
./build-and-start.sh
```

The health endpoint is `GET /healthz`.
