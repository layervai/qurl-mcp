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

Run the commands below from the `qurl-connector` directory.

Copy the included example, then set `apiKey` to a qURL credential permitted to
call the resource `share` API. Keep the resulting `qurl-connector.json` out of
source control and restrict its filesystem permissions:

```json
{
  "listenAddr": "127.0.0.1:3100",
  "apiBaseUrl": "https://api.layerv.xyz",
  "apiKey": "REPLACE_WITH_QURL_CREDENTIAL_WITH_RESOURCE_SHARE_PERMISSION",
  "deploymentPath": "qurl-deployment.xyz.json",
  "allowedLinkHosts": ["qurl.link", "qurl.link.layerv.xyz"],
  "cridHeader": "X-MCP-CRID",
  "dynamicCrid": true
}
```

The same configuration is available in
[`qurl-connector.example.json`](qurl-connector.example.json). It targets the
sandbox API, and the included sandbox deployment uses `qurl.link.layerv.xyz`.
For production, set `apiBaseUrl` to `https://api.layerv.ai`; for a private
deployment, replace `deploymentPath` and allow its link host explicitly.

`listenAddr` defaults to `127.0.0.1:3100`. The connector does not authenticate
its clients and spends the configured qURL credential on their behalf, so bind
it to a non-loopback address only behind a network boundary or an
authenticating proxy.

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

## Dynamic CRID Mode

With `dynamicCrid` enabled (the default), a client can connect without a CRID
header. The connector then answers `initialize` itself and exposes three tools
whose arguments carry the CRID:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `qurl_list_tools` | `crid`, optional `cursor` | Lists the tools of the protected MCP server |
| `qurl_call_tool` | `crid`, `name`, optional `arguments` | Calls one tool and returns its result unchanged |
| `qurl_get_link` | `crid` | Returns a new qURL access link without calling any MCP server |

```toml
[mcp_servers.qurl]
enabled = true
url = "http://127.0.0.1:3100/mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Users do not have to say "CRID". A value written with a leading dollar sign,
for example `List the tools of $r_abc123` or `Use $r_abc123 to search for
qURL`, is treated as a CRID: the connector's instructions and tool descriptions
tell the model this, and the connector strips one leading `$` from any CRID it
receives. The same applies to CRID headers, the `crid` query
parameter, and the top-level JSON `crid` field.

The model picks the tool from what the user asks for. Only an explicit request
to use the CRID as an MCP server, such as `List the tools of $r_abc123` or
`Use $r_abc123 to search for qURL`, goes to `qurl_list_tools` or
`qurl_call_tool`. Everything else, such as `Give me a qURL link for $r_abc123`,
`Give me an access link to $r_abc123`, or `Open $r_abc123`, goes to
`qurl_get_link`. Use `qurl_get_link` for protected HTTP services: it shares the
CRID and returns the link for a browser, without opening a portal or starting
an MCP session. If an MCP meta-tool is used on a CRID that is not an MCP server,
the backend `initialize` fails and the error tells the model to call
`qurl_get_link` instead.

`qurl_get_link` returns the link to the model, so it appears in the
conversation. Anyone holding it can open the resource until it expires, and
each call mints a new link.

The first MCP tool call for a CRID shares it, opens the qURL portal, and initializes an
MCP session with the backend MCP server. Later calls with the same CRID in the
same connector session reuse that backend session. One connector session can
use up to 32 CRIDs. If the backend session expires (HTTP 404), the connector
re-initializes it once; if the portal authorization is rejected (HTTP 401 or
403), it shares the CRID again once. Deleting the connector session closes all
of its backend sessions.

Dynamic sessions forward tool listing and tool calls only. Backend resources,
prompts, and server-initiated requests such as sampling are not relayed; use a
CRID header when a client needs the full backend MCP surface. Set
`"dynamicCrid": false` to require a CRID on every new session.

## Troubleshooting

- `missing CRID`: provide `X-MCP-CRID`, another supported CRID header, a
  `crid` query parameter, or a top-level JSON `crid` field. With
  `dynamicCrid` enabled, only non-`initialize` requests without a session
  return this error.
- `CRID cannot be sent for a dynamic CRID session`: remove the CRID header and
  pass `crid` as a tool argument instead.
- `failed to obtain qurl link`: verify the configured API key, CRID, API URL,
  and share permission.
- `invalid qurl link`: add the expected host to `allowedLinkHosts`.
- `failed to open qurl portal`: verify `deploymentPath` or `QURL_DEPLOYMENT`,
  issuer trust keys, relay configuration, and network connectivity.
- Unknown or expired `Mcp-Session-Id`: initialize a new MCP session.
