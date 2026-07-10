# @layervai/qurl-mcp

[![npm version](https://img.shields.io/npm/v/@layervai/qurl-mcp.svg)](https://www.npmjs.com/package/@layervai/qurl-mcp)

> **⚠️ Renamed from `@layerv/qurl-mcp` in v0.4.0.** The old package is deprecated and will not receive further updates. If you're using `@layerv/qurl-mcp@0.3.x`, swap the scope in your MCP client config — same binary, same API key, no other changes.

> A qURL MCP Server that supports both local `stdio` mode and remote `HTTP` mode for creating, managing, resolving, and sharing secure access links.

## Overview

`qURL MCP` exposes qURL capabilities to MCP clients, GPTs, ChatGPT, and other remote integrations.

It currently supports:

- creating, reading, updating, and deleting qURLs
- resolving access tokens
- managing qURL tokens and sessions
- uploading text or file content and generating qURLs
- serving public legal pages
- serving a configurable MP4 video playback page

## Runtime Modes

| Mode    | Purpose                         | Start Command        | Typical Use Case                                           |
| ------- | ------------------------------- | -------------------- | ---------------------------------------------------------- |
| `stdio` | Local subprocess MCP server     | `npm run start`      | Claude Desktop, Cursor, Codex, and other local MCP clients |
| `http`  | Authenticated remote MCP server | `npm run start:http` | Remote agent runtimes behind HTTPS                         |

## Feature Map

### qURL Management Tools

| Tool                      | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `create_qurl`             | Create a new qURL                                   |
| `resolve_qurl`            | Resolve an access token into a protected target URL |
| `list_qurls`              | List qURL resources                                 |
| `get_qurl`                | Fetch details for a single qURL                     |
| `delete_qurl`             | Delete a qURL                                       |
| `extend_qurl`             | Extend qURL expiration                              |
| `update_qurl`             | Update qURL metadata or expiration                  |
| `mint_link`               | Mint a new access link for an existing resource     |
| `batch_create_qurls`      | Create multiple qURLs in one request                |
| `revoke_qurl_token`       | Revoke a specific token                             |
| `update_qurl_token`       | Update a specific token                             |
| `list_qurl_sessions`      | List active access sessions                         |
| `terminate_qurl_sessions` | Terminate one or all active sessions                |

### Upload Tools

| Tool                    | Mode         | Description                                |
| ----------------------- | ------------ | ------------------------------------------ |
| `upload_file_qurl`      | `stdio`      | Upload a local file and mint a qURL        |
| `upload_file_data_qurl` | `stdio`/HTTP | Upload base64 file content and mint a qURL |
| `upload_text_qurl`      | `stdio`/HTTP | Upload text content and mint a qURL        |

`upload_file_qurl` is intentionally stdio-only. It can read any supported
PDF/image that the local MCP process user can access, so agents should invoke
it only for a path the user explicitly selected for sharing. Do not expose it
to untrusted prompts or autonomous agents: prompt injection could otherwise
select another readable PDF/image on the host. Run stdio under an OS account
whose filesystem access is limited to intended shareable content. HTTP mode
never registers this host-file tool.
The byte/text tools are also available in stdio so local clients can share
in-chat attachments without first materializing them at a known host path.
Connector upload and qURL minting are separate operations. If minting fails
after upload, the connector currently has no delete endpoint; the server logs
the orphaned `resource_id` for operator cleanup and returns the mint failure.
Upload validation binds the declared media type to the filename plus format
start/end markers; it is not a malware scanner or full PDF/image decoder.
Connectors must preserve the declared safe media type and serve downloads with
`X-Content-Type-Options: nosniff` rather than inferring an executable type.
There is intentionally no application-level path allowlist: symlinks and
time-of-check/time-of-use races make a lexical prefix check a misleading
security boundary. Use a dedicated OS account, container, or read-only mount
whose readable files are already limited to the intended sharing directory.
The final path component is opened with `O_NOFOLLOW`; intermediate directory
symlinks retain normal filesystem behavior under this trusted-local-user
boundary.

### MCP Resources

| URI            | Description                         |
| -------------- | ----------------------------------- |
| `qurl://links` | Current qURL list                   |
| `qurl://usage` | Current quota and usage information |

### MCP Prompts

| Prompt             | Description                       |
| ------------------ | --------------------------------- |
| `secure_a_service` | Secure service integration prompt |
| `audit_links`      | Link audit prompt                 |
| `rotate_access`    | Access rotation prompt            |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Start

Local `stdio` mode:

```bash
npm run start
```

Remote `HTTP` mode:

```bash
npm run start:http
```

## MCP Client Example

If you want to use this server in `stdio` mode with a local MCP client:

```json
{
  "mcpServers": {
    "qurl": {
      "command": "npx",
      "args": ["@layervai/qurl-mcp"],
      "env": { "QURL_API_KEY": "lv_live_xxx" }
    }
  }
}
```

## Configuration Files

Copy the tracked examples to create local configuration files:

```bash
cp qurl-mcp.config.example.json qurl-mcp.config.json
cp qurl-mcp.http.example.json qurl-mcp.http.json
```

The local files are gitignored so credentials and machine-specific paths are
not committed.

Their responsibilities are:

| File                   | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `qurl-mcp.config.json` | Shared runtime config used by both `stdio` and `http` modes |
| `qurl-mcp.http.json`   | HTTP-only server listener and public access config          |

## qurl-mcp.config.json Reference

### Shared Core Settings

| Field                     | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `maxUploadFileDataBytes`  | Limits decoded and local file uploads (default `10mb`) |
| `defaultQurlApiUrl`       | Base URL of the qURL backend API                       |
| `defaultQurlConnectorUrl` | Base URL of the upload connector                       |

Shared settings have these environment overrides. Environment values take
precedence over the shared config file.
The process caches resolved shared settings but automatically invalidates that
cache when the file metadata or any relevant environment value changes.

| Environment variable                   | Config field                   |
| -------------------------------------- | ------------------------------ |
| `MCP_MAX_UPLOAD_FILE_DATA_BYTES`       | `maxUploadFileDataBytes`       |
| `QURL_API_URL`                         | `defaultQurlApiUrl`            |
| `QURL_CONNECTOR_URL`                   | `defaultQurlConnectorUrl`      |
| `QURL_SMTP_HOST`                       | `smtp.host`                    |
| `QURL_SMTP_PORT`                       | `smtp.port`                    |
| `QURL_SMTP_SECURE`                     | `smtp.secure`                  |
| `QURL_SMTP_USERNAME`                   | `smtp.username`                |
| `QURL_SMTP_PASSWORD`                   | `smtp.password`                |
| `QURL_SMTP_FROM_EMAIL`                 | `smtp.fromEmail`               |
| `QURL_SMTP_FROM_NAME`                  | `smtp.fromName`                |
| `QURL_SMTP_ALLOWED_RECIPIENTS`         | `smtp.allowedRecipients`       |
| `QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS`  | `smtp.allowedRecipientDomains` |
| `QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE` | `smtp.maxRecipientsPerMessage` |
| `QURL_SMTP_MAX_RECIPIENTS_PER_HOUR`    | `smtp.maxRecipientsPerHour`    |
| `QURL_PUBLIC_VIDEO_FILE_PATH`          | `publicVideo.filePath`         |
| `QURL_PUBLIC_VIDEO_TITLE`              | `publicVideo.title`            |
| `QURL_PUBLIC_VIDEO_PAGE_PATH`          | `publicVideo.pagePath`         |

`QURL_API_KEY` is intentionally environment-only and has no config-file field.

Raising `maxUploadFileDataBytes` also raises the HTTP JSON parser's per-request
memory ceiling to roughly 1.5 times that value (up to about 150 MB at the
100 MB maximum), before base64 decoding applies the exact byte cap. Until a
session has completed a successful downstream qURL API call, its parser ceiling
remains at the smaller 10 MB default upload setting; clients configured for a
larger first upload must validate the session with a small qURL API call first.
Size the configured maximum and reverse-proxy concurrency limit together.

Set `QURL_API_KEY` in the environment for `stdio` mode. In HTTP mode, every
client request supplies its own qURL API key as a bearer token.

`defaultQurlApiUrl` and `QURL_API_URL` require HTTPS for non-loopback hosts
because qURL API keys and data are bearer-sent to that destination. Plain HTTP
is accepted only for literal loopback development endpoints. Upload connector
URLs follow the same HTTPS-except-loopback rule.
Loopback means `127.0.0.0/8` or `::1`; wildcard bind addresses such as
`0.0.0.0` and `::` are intentionally not accepted as outbound HTTP targets.
Connector destinations are trusted operator configuration rather than caller
input; private addresses and DNS resolution are therefore permitted. Pin the
connector hostname in deployment DNS and do not point it at metadata services.

API and connector base URLs that contain embedded credentials, a query string,
or a fragment are now rejected during startup. Deployments that previously used
one of those unusual URL forms must move credentials to `QURL_API_KEY` and keep
the configured service URL to its origin and optional path prefix.

### SMTP Settings

| Field                          | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `smtp.host`                    | SMTP server hostname                                                         |
| `smtp.port`                    | SMTP server port                                                             |
| `smtp.secure`                  | `true` for implicit TLS; `false` for required STARTTLS                       |
| `smtp.username`                | SMTP login username                                                          |
| `smtp.password`                | SMTP login password or app-specific code                                     |
| `smtp.fromEmail`               | Sender email address                                                         |
| `smtp.fromName`                | Sender display name                                                          |
| `smtp.allowedRecipients`       | Optional exact-address allowlist                                             |
| `smtp.allowedRecipientDomains` | Optional exact-domain allowlist (subdomains are not included)                |
| `smtp.maxRecipientsPerMessage` | Per-message recipient cap (default `10`)                                     |
| `smtp.maxRecipientsPerHour`    | Per-qURL-key attempted-recipient cap per fixed hourly window (default `100`) |

These settings are used when email delivery is requested by tools such as:

- `create_qurl`
- `mint_link`
- `upload_text_qurl`
- `upload_file_qurl`
- `upload_file_data_qurl`

If either recipient allowlist is configured, only an exact address or domain
match is delivered. If both are empty, the message and hourly caps still apply.
Domain entries are exact: `example.com` does not implicitly allow
`mail.example.com`; list each permitted subdomain explicitly.
Addresses and domains are normalized to lowercase NFC/IDNA ASCII form and a
trailing DNS root dot is removed before comparison and delivery.
Each recipient allowlist is limited to 1,000 configured entries. The
per-message recipient cap applies to the complete unique requested fan-out
before allowlist filtering, so blocked addresses cannot be used to submit an
oversized batch.
In HTTP mode, any caller with a valid qURL API key can request a server-side
SMTP delivery. Configure `allowedRecipients` or `allowedRecipientDomains`
before enabling SMTP on an Internet-facing HTTP deployment; empty allowlists
permit delivery to any syntactically valid address subject to the quotas.
The SMTP transport uses bounded connection/socket timeouts and is closed after
each delivery batch. Failed SMTP attempts still consume quota so repeated
failures cannot bypass the abuse limit.
Transport encryption is mandatory: `smtp.secure: true` uses implicit TLS,
while `smtp.secure: false` requires a successful STARTTLS upgrade.
Hourly quota state is maintained per server process: it resets on restart and
is not shared across replicas. Operators running multiple instances should
enforce a corresponding aggregate limit at the SMTP provider or gateway.
Tracking fails closed for new principals after 10,000 principals are retained
in one process; existing principals continue to use their current buckets until
expired entries are pruned.
The quota uses a fixed one-hour window that starts with the first attempted
delivery after the prior window expires.
As with any fixed window, traffic immediately before and after a boundary can
total nearly twice the configured hourly value; use a provider-side sliding or
rolling limit when that boundary burst must be prevented across replicas.
Generated qURL links are included in the plain-text email body. Restrict
recipients with the SMTP allowlists and configure transport encryption at the
SMTP server/provider when link confidentiality matters.

Prefer environment variables for SMTP credentials and policy:
`QURL_SMTP_USERNAME`, `QURL_SMTP_PASSWORD`, `QURL_SMTP_FROM_EMAIL`,
`QURL_SMTP_ALLOWED_RECIPIENTS`, `QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS`,
`QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE`, and
`QURL_SMTP_MAX_RECIPIENTS_PER_HOUR`.

### Public Video Page Settings

| Field                  | Purpose                                |
| ---------------------- | -------------------------------------- |
| `publicVideo.title`    | Title shown on the public video page   |
| `publicVideo.pagePath` | Public path of the video playback page |
| `publicVideo.filePath` | Absolute server path of the MP4 file   |

When configured, the HTTP server additionally exposes:

- a public video playback page
- a streaming endpoint for the MP4 file

## qurl-mcp.http.json Reference

| Field                          | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `port`                         | HTTP MCP listener port                                                              |
| `host`                         | HTTP MCP bind address                                                               |
| `baseUrl`                      | Public base URL of the service                                                      |
| `allowedHosts`                 | Host allowlist for Host header validation                                           |
| `trustProxyHops`               | Exact trusted reverse-proxy hop count (default `0`)                                 |
| `maxSessions`                  | Hard cap on live MCP sessions (default `1000`)                                      |
| `maxSessionsPerCredential`     | Per-bearer live and initializing session cap (default `20`)                         |
| `maxUnvalidatedSessions`       | Cap on sessions that have not completed a downstream qURL API call (default `100`)  |
| `sessionIdleTtlMs`             | Connected-session idle eviction window (default 15 minutes)                         |
| `sessionAbsoluteTtlMs`         | Absolute session lifetime, including active SSE/tool requests (default 24 hours)    |
| `unvalidatedSessionTtlMs`      | Absolute validation deadline for never-validated bearer sessions (default 1 minute) |
| `mcpRateLimitPerMinute`        | Per-client `/mcp` request limit (default `120`)                                     |
| `publicFileRateLimitPerMinute` | Per-client public-route request limit (default `300`)                               |

HTTP fields have matching environment overrides:

| Environment variable                    | Config field                      |
| --------------------------------------- | --------------------------------- |
| `MCP_PORT`                              | `port`                            |
| `MCP_HOST`                              | `host`                            |
| `MCP_BASE_URL`                          | `baseUrl`                         |
| `MCP_ALLOWED_HOSTS`                     | `allowedHosts`                    |
| `MCP_TRUST_PROXY_HOPS`                  | `trustProxyHops`                  |
| `MCP_MAX_SESSIONS`                      | `maxSessions`                     |
| `MCP_MAX_SESSIONS_PER_CREDENTIAL`       | `maxSessionsPerCredential`        |
| `MCP_MAX_UNVALIDATED_SESSIONS`          | `maxUnvalidatedSessions`          |
| `MCP_SESSION_IDLE_TTL_MS`               | `sessionIdleTtlMs`                |
| `MCP_SESSION_ABSOLUTE_TTL_MS`           | `sessionAbsoluteTtlMs`            |
| `MCP_UNVALIDATED_SESSION_TTL_MS`        | `unvalidatedSessionTtlMs`         |
| `MCP_RATE_LIMIT_PER_MINUTE`             | `mcpRateLimitPerMinute`           |
| `MCP_PUBLIC_FILE_RATE_LIMIT_PER_MINUTE` | `publicFileRateLimitPerMinute`    |
| `MCP_MAX_UPLOAD_FILE_DATA_BYTES`        | `maxUploadFileDataBytes` (shared) |

The listener defaults to `127.0.0.1`. A non-loopback `host` is rejected unless
`allowedHosts` is explicitly configured. Set `trustProxyHops` (or
`MCP_TRUST_PROXY_HOPS`) to the exact number of trusted proxy hops; leave it at
`0` for direct connections so forwarded IP headers cannot spoof rate-limit keys.
The Host allowlist is limited to 1,000 entries so request-time validation stays
bounded even under pathological operator configuration.
`/mcp` applies the configured request allowance independently to both the
client IP and the SHA-256 digest of the authenticated bearer. Reverse-proxy
deployments must set the correct hop count or all callers behind the proxy will
share the proxy's single IP bucket. The credential bucket also prevents one
key from bypassing the request allowance by rotating source IPs, while
`maxSessionsPerCredential` prevents it from occupying the full session pool.
Bearer credentials are conclusively validated by the first successful
downstream qURL API call. Until then, sessions use the smaller pending-session
cap and one-minute validation deadline, so arbitrary non-empty bearer strings
cannot occupy the full session pool for the normal 15-minute TTL. A client that
performs only MCP introspection remains pending by design; after deadline
eviction it must re-initialize before its next request. The session caps and
validation deadline are configurable for clients with longer
introspection-to-tool-call gaps. The deadline is absolute and applies regardless
of activity, including an open SSE stream or a long-running first tool call.
Validated clients that disconnect without sending `DELETE /mcp` retain their
bounded session slot for a 30-second reconnect grace period. A reconnect clears
that deadline; otherwise the session is reaped without waiting for the longer
idle TTL. Size `maxSessions` and the idle TTL for clients that remain connected
but do not perform explicit session teardown.
Validated sessions also expire at `sessionAbsoluteTtlMs` (24 hours by default),
even during an active SSE stream or tool request. This prevents keepalives from
pinning a global or per-credential session slot indefinitely.
The first downstream qURL operation must therefore complete before that
deadline; an unusually slow first API call may be interrupted and the client
must re-initialize. This fail-closed behavior prevents an invalid credential
from extending its pending slot with a deliberately long-running request.
Accepting a non-empty bearer during MCP initialization is intentional: it keeps
protocol introspection available before the first qURL operation, while the
global session cap, per-credential session cap, pending-session cap, absolute
deadline, and request rate limit bound invalid-key slot usage. The MCP
middleware does not validate the key itself; only a successful downstream qURL
API response promotes the session.
Downstream errors, including non-2xx responses that appear authenticated, do
not promote it because an intermediary may have generated them before the qURL
API authenticated the bearer.
Promotion therefore assumes the configured HTTPS qURL API endpoint and every
trusted intermediary neither cache nor synthesize authenticated success
responses. Reverse proxies in that path must forward authorization and disable
response caching for qURL API traffic.
Consequently, any caller with a non-empty bearer can enumerate the public
tool/resource/prompt catalog and briefly hold bounded pending-session state. On
hostile networks, place non-loopback deployments behind an identity-aware proxy
that preserves the caller's qURL bearer credential for `/mcp` authorization.

Session caps, request rate limits, and email recipient quotas are in-memory and
apply independently to each server process. A horizontally scaled deployment
therefore has aggregate limits of roughly the configured value multiplied by
its instance count; use shared edge limits or a single routed instance when a
global cap is required.
`/healthz` and the public video-file endpoint each use their own
`publicFileRateLimitPerMinute` bucket, isolated from legal/video-page traffic
and from each other. Keep load-balancer, liveness-probe, and expected video
range-request frequency below that per-source-IP allowance (300
requests/minute by default), or raise it for unusually aggressive clients.

## Configuration Priority

By default, configuration is loaded from the two local JSON files above. If a
file is absent, built-in defaults and environment variables are used.
Relative config paths—including the defaults—are resolved from the process
working directory. Set the explicit path variables below when a supervisor,
`npx`, or an MCP host launches the server from a different directory.

The following environment variables independently override the config file paths:

- `QURL_MCP_CONFIG`
- `QURL_MCP_HTTP_CONFIG`

`QURL_MCP_HTTP_CONFIG` never replaces the shared runtime config path. This keeps
listener settings from silently shadowing SMTP, connector, or API settings.

`server.json` and `smithery.yaml` describe the published stdio transport, so
they include shared upload/SMTP settings but intentionally omit HTTP-only
listener variables such as `QURL_MCP_HTTP_CONFIG` and `MCP_MAX_SESSIONS`.

Do not commit API keys, SMTP credentials, or private file-system paths.

## HTTP Routes

After starting in `http` mode, the common routes are:

| Route                          | Purpose                      |
| ------------------------------ | ---------------------------- |
| `/mcp`                         | Main remote MCP endpoint     |
| `/healthz`                     | Health check endpoint        |
| `/legal/privacy`               | Public privacy policy page   |
| `/legal/terms`                 | Public terms of service page |
| `publicVideo.pagePath`         | Public video playback page   |
| `publicVideo.pagePath + /file` | MP4 streaming endpoint       |

`/healthz` is intentionally unauthenticated, exposes only `{ "ok": true }`, and
uses the configured public-route request limit in a separate bucket so health
probes cannot consume the legal/video route allowance.

## HTTP Authentication

The `/mcp` endpoint requires `Authorization: Bearer <qURL API key>` on every
request. The bearer token is bound to the resulting MCP session, so a session
ID cannot be reused with a different credential.

Initialization accepts any non-empty bearer token and defers authoritative key
validation to the first downstream qURL API call. Unvalidated-session caps, a
short validation deadline, and request rate limits bound that pre-validation
state; the supplied token is forwarded only to the configured qURL API.
Introspection-only sessions therefore remain unvalidated and are closed at
`unvalidatedSessionTtlMs`; clients can re-initialize if they need a longer-lived
session. A session is promoted only after a successful qURL API call—rejected
or rate-limited calls do not prove the credential valid. Disconnected sessions
remain registered for a 30-second SSE reconnect grace period, while
`maxSessions` and `maxSessionsPerCredential` bound that allowance under churn.

Requests without an `Origin` header are accepted for non-browser MCP clients.
When `Origin` is present, it must match the origin of `baseUrl`; malformed or
cross-origin values are rejected on `/mcp`. Public health, legal, and configured
video routes do not use browser-origin state and are not gated by this check.

Configure remote MCP clients with:

| Setting        | Value                             |
| -------------- | --------------------------------- |
| MCP Server URL | Your public HTTPS URL plus `/mcp` |
| Authentication | Bearer token                      |
| Token          | The caller's qURL API key         |

If a client only supports OAuth discovery, place an OAuth-compatible gateway
in front of this server rather than exposing `/mcp` without authentication.

## How to Verify Deployment

### Service-Level Checks

Start with:

- `/healthz`
- `/mcp`

### Public Page Checks

Also verify the legal pages and, when configured, the video page:

- `/legal/privacy`
- `/legal/terms`
- the configured public video page path

### Domain Verification

If you plan to use OpenAI Platform, make sure the following root-level path exists:

```text
/.well-known/openai-apps-challenge
```

> This verification file must live under the domain root `.well-known` path, not under `/mcp`.

## Docker

The repository includes a Dockerfile for containerized deployment.

Example:

```bash
docker build -t qurl-mcp .
docker run -i -e QURL_API_KEY=lv_live_xxx qurl-mcp
```

If you deploy with Docker, make sure the container can still access the correct config files, or override the config file paths with environment variables.

Run HTTP mode locally in Docker:

The image defaults to the stdio entry point and the HTTP server defaults to
container-local loopback. HTTP deployments must override the command and bind
to `0.0.0.0` with an explicit Host allowlist:

```bash
docker run --rm -p 3000:3000 \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_ALLOWED_HOSTS=127.0.0.1,localhost \
  qurl-mcp node dist/http.js
```

For a single trusted production reverse proxy, set
`MCP_TRUST_PROXY_HOPS=1`, use the public HTTPS origin in `MCP_BASE_URL`, and
set `MCP_ALLOWED_HOSTS` to the public hostname. Do not expose the container's
listener directly when proxy trust is enabled.

## Common Commands

| Command                | Purpose               |
| ---------------------- | --------------------- |
| `npm run build`        | Compile TypeScript    |
| `npm test`             | Run tests             |
| `npm run lint`         | Run ESLint            |
| `npm run dev`          | TypeScript watch mode |
| `npm run format`       | Format source code    |
| `npm run format:check` | Check formatting      |
| `npm run start`        | Start stdio mode      |
| `npm run start:http`   | Start HTTP mode       |

## Recommended Deployment Order

1. Copy and update the two example config files
2. Set credentials through environment variables
3. Run `npm install`
4. Run `npm run build`
5. Run `npm run start:http`
6. Verify `/healthz`
7. Verify unauthenticated `/mcp` requests receive `401`
8. Configure the HTTPS reverse proxy
9. Verify an authenticated MCP initialization and the optional public pages

## Third-Party Assets

Text-to-PDF generation bundles Noto Sans SC for multilingual glyph coverage.
Its SIL Open Font License and copyright notice are included in
`assets/fonts/OFL.txt`.

## License

MIT -- [LayerV AI](https://layerv.ai)
