# qurl-connector Usage

qURL Connector establishes qURL authorization from a CRID and reuses that
authorization for one MCP session.

For a new MCP `initialize` request, the connector reads the CRID, calls
`POST /v1/resources/{CRID}/share`, opens the returned qURL link, proxies the
initialization request, and records the returned `Mcp-Session-Id`. Subsequent
tool calls, SSE reconnects, and `DELETE` requests reuse the registered portal.
The registration is removed after a successful `DELETE`, 15 minutes of idle
time, 24 hours of absolute lifetime, or a connector restart.

## Prerequisites

- Go 1.26 or later.
- A qURL credential permitted to call the resource `share` API.
- The CRID of the protected MCP resource.
- A qURL SDK deployment/trust configuration for sandbox or private deployments.

## Configure

From the project directory:

```bash
cd /Users/ymh/code/open-project/qurl-mcp/qurl-connector
```

Create `qurl-connector.json` with restrictive filesystem permissions:

```json
{
  "listenAddr": "0.0.0.0:3100",
  "apiBaseUrl": "https://api.layerv.ai",
  "apiKey": "",
  "deploymentPath": "/secure/path/qurl-deployment.json",
  "allowedLinkHosts": ["qurl.link"],
  "cridHeader": "X-MCP-CRID"
}
```

`deploymentPath` is resolved relative to the JSON configuration file. If it is
omitted, the connector uses `QURL_DEPLOYMENT`. `apiBaseUrl` and `apiKey` are
read only from the configuration file; `apiKey` is required for `share`.

Set `QURL_CONNECTOR_CONFIG` to use another configuration file. The previous
`QURL_CLI_MCP_GATEWAY_CONFIG` name is accepted as a migration fallback.

## Build And Start

```bash
./build-and-start.sh
```

Useful overrides:

```bash
QURL_CONNECTOR_CONFIG=/etc/qurl-connector.json ./build-and-start.sh
QURL_CONNECTOR_SKIP_BUILD=1 ./build-and-start.sh
```

Verify the service:

```bash
curl http://127.0.0.1:3100/healthz
# {"ok":true}
```

## Client Configuration

Use one connector URL for each protected resource and set a unique CRID in the
client headers:

```toml
[mcp_servers.mcp_a]
enabled = true
url = "http://127.0.0.1:3100/mcp"
http_headers = { "X-MCP-CRID" = "<MCP_A_CRID>" }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Do not put qURL API keys or temporary qURL links in the MCP client
configuration. The connector obtains the link only when creating a new session.

## Troubleshooting

- `missing CRID`: provide `X-MCP-CRID`, another supported CRID header, a
  `crid` query parameter, or a top-level JSON `crid` field.
- `failed to obtain qurl link`: verify the configured API key, CRID, API URL,
  and share permission.
- `invalid qurl link`: add the expected host to `allowedLinkHosts`.
- `failed to open qurl portal`: verify `deploymentPath` or `QURL_DEPLOYMENT`,
  issuer trust keys, relay configuration, and network connectivity.
- Unknown or expired `Mcp-Session-Id`: initialize a new MCP session.
