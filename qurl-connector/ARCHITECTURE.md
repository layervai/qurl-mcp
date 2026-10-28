# qURL Connector Architecture

qURL Connector is a session-aware reverse proxy between MCP clients and
protected MCP resources.

## Boundaries

- The client sends a CRID and standard Streamable HTTP MCP requests.
- The connector calls the qURL `share` API once for a new MCP session.
- The qURL SDK validates and opens the returned portal.
- The connector stores `Mcp-Session-Id -> portal / resource URL / CRID` in
  process memory.
- Subsequent MCP, SSE, and `DELETE` requests are routed through that portal.

qURL credentials, portal handles, and session cookies remain inside the
connector. CRID headers and query parameters are removed before proxying to the
upstream MCP resource.

## Session Lifecycle

| Event | Connector action | Share call |
| --- | --- | --- |
| New `initialize` without a session ID | Create and register a portal | Once |
| Tool call or SSE reconnect | Reuse the registered portal | None |
| Successful `DELETE` | Forward the close request and remove the session | None |
| Idle timeout, absolute timeout, or restart | Remove the session | Next initialize |

The registry is process-local. Production deployments should use sticky routing
for requests belonging to one MCP session. Cross-instance reuse requires a
session layer that can safely recreate or share portal authorization; a portal
handle must not be serialized into an ordinary cache.

## Dynamic CRID Sessions

When `dynamicCrid` is enabled and `initialize` arrives without a CRID, the
connector creates its own MCP session (`qc_` session ID) instead of proxying.
It exposes `qurl_list_tools`, `qurl_call_tool`, and `qurl_get_link`; each call
names a CRID. `qurl_get_link` only shares the CRID and returns the link, so it
also serves protected HTTP services and keeps no state. For the two MCP tools,
the connector keeps one portal and one backend MCP client session for each CRID
per connector session, created on first use:

| Event | Connector action | Share call |
| --- | --- | --- |
| `initialize` without CRID | Create a connector session | None |
| First tool call for a CRID | Open a portal and initialize a backend session | Once |
| Later tool call for that CRID | Reuse the backend session | None |
| `qurl_get_link` call | Return the validated qURL link | Every call |
| Backend returns 404 | Re-initialize the backend session through the same portal | None |
| Backend returns 401 or 403 | Open a new portal and backend session | Once |
| `DELETE`, idle/absolute timeout | Close all backend sessions and remove the session | None |

Only `tools/list` and `tools/call` are relayed in this mode.

## Request Flow

```text
MCP client -- CRID + initialize --> qURL Connector
qURL Connector -- share(CRID) --> qURL API
qURL Connector -- EnterPortal --> qURL relay
qURL Connector -- authorized MCP --> protected MCP resource
```
