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

## Request Flow

```text
MCP client -- CRID + initialize --> qURL Connector
qURL Connector -- share(CRID) --> qURL API
qURL Connector -- EnterPortal --> qURL relay
qURL Connector -- authorized MCP --> protected MCP resource
```
