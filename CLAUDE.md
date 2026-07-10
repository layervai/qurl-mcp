# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL RULES - NEVER VIOLATE

> **NEVER push directly to `main` branch.** All changes MUST go through a Pull Request, no exceptions. This applies even for "quick fixes" or "urgent" changes. Create a branch, open a PR, and let CI run.

> **All commits must be GPG/SSH signed.** Unsigned commits will be rejected by GitHub branch protection rules.

## Code Change Workflow

Follow this process for all code changes:

1. **Switch to main and fetch latest**

   ```bash
   git checkout main && git pull origin main
   ```

2. **Create branch for code change**

   ```bash
   git checkout -b <type>/<short-description>
   ```

3. **Make code changes** - Think deeply about the implementation. Consider edge cases, error handling, and maintainability.

4. **Run checks before committing**

   ```bash
   npm run build && npm run lint && npm test
   ```

5. **Create a PR**

   ```bash
   git push -u origin <branch>
   gh pr create --title "<type>(scope): description" --body "..."
   ```

6. **Wait for code review feedback** - CI runs automatically. Review comments will be posted on the PR.

7. **Address review feedback** - Think critically about each suggestion.

8. **Update the PR** - Push fixes, update PR description if needed.

9. **Repeat steps 6-8** until feedback requires no further action.

---

## Project Overview

qURL MCP Server is a TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes qURL operations as tools for AI agents. It supports local stdio and authenticated Streamable HTTP transports, and communicates with the qURL API plus an optional upload connector.

## Architecture

```
qurl-mcp/
├── src/
│   ├── index.ts           # Entry point, env validation, stdio transport
│   ├── http.ts            # Authenticated HTTP transport and public routes
│   ├── http-config.ts     # Bounded listener/session/proxy configuration
│   ├── config.ts          # Shared qURL, connector, SMTP, and media config
│   ├── server.ts          # MCP server factory, tool/resource/prompt registration
│   ├── client.ts          # Adapter over the @layervai/qurl SDK (IQURLClient + QURLAPIError)
│   ├── tools/
│   │   ├── _shared.ts       # resourceIdSchema, zodErrorToToolResult
│   │   ├── create-qurl.ts
│   │   ├── resolve-qurl.ts
│   │   ├── list-qurls.ts
│   │   ├── get-qurl.ts
│   │   ├── delete-qurl.ts
│   │   ├── extend-qurl.ts
│   │   ├── update-qurl.ts
│   │   ├── mint-link.ts
│   │   ├── batch-create.ts
│   │   └── upload-*.ts    # File/data/text upload workflows
│   ├── auth/              # Request-scoped credentials and bearer verification
│   ├── services/          # Email, PDF, legal-page, and video-page services
│   ├── resources/
│   │   ├── links.ts
│   │   └── usage.ts
│   └── prompts/
│       ├── secure-a-service.ts
│       ├── audit-links.ts
│       └── rotate-access.ts
├── dist/                  # Compiled output (gitignored)
├── package.json
└── tsconfig.json
```

## Common Commands

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run
npm start

# Lint
npm run lint

# Test
npm test

# Format
npm run format
```

## Configuration

| Variable               | Required  | Description                                                          | Default                 |
| ---------------------- | --------- | -------------------------------------------------------------------- | ----------------------- |
| `QURL_API_KEY`         | Yes       | API key with `qurl:read`, `qurl:write`, and/or `qurl:resolve` scopes | —                       |
| `QURL_API_URL`         | No        | qURL API base URL                                                    | `https://api.layerv.ai` |
| `QURL_CONNECTOR_URL`   | Uploads   | HTTPS connector base URL                                             | —                       |
| `QURL_MCP_CONFIG`      | No        | Shared runtime config path                                           | `qurl-mcp.config.json`  |
| `QURL_MCP_HTTP_CONFIG` | HTTP only | HTTP listener config path                                            | `qurl-mcp.http.json`    |

See `README.md` and the two tracked `*.example.json` files for the complete
SMTP, upload-limit, proxy, session, and public-page settings.

## MCP Usage

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

## Tools

| Tool                      | Scope Required | Description                                             |
| ------------------------- | -------------- | ------------------------------------------------------- |
| `create_qurl`             | `qurl:write`   | Create a protected link                                 |
| `resolve_qurl`            | `qurl:resolve` | Resolve token + grant network access                    |
| `list_qurls`              | `qurl:read`    | List qURLs with filtering                               |
| `get_qurl`                | `qurl:read`    | Get qURL details                                        |
| `delete_qurl`             | `qurl:write`   | Revoke a qURL                                           |
| `extend_qurl`             | `qurl:write`   | Extend expiration (shorthand alias for `update_qurl`)   |
| `update_qurl`             | `qurl:write`   | Update expiration, tags, description                    |
| `mint_link`               | `qurl:write`   | Mint a new access link for an existing resource         |
| `batch_create_qurls`      | `qurl:write`   | Create multiple qURLs at once                           |
| `revoke_qurl_token`       | `qurl:write`   | Revoke one access token                                 |
| `update_qurl_token`       | `qurl:write`   | Update one access token                                 |
| `list_qurl_sessions`      | `qurl:read`    | List active resource sessions                           |
| `terminate_qurl_sessions` | `qurl:write`   | Terminate one or all resource sessions                  |
| `upload_file_qurl`        | `qurl:write`   | Upload a server-local file and mint a qURL (stdio only) |
| `upload_file_data_qurl`   | `qurl:write`   | Upload base64 file content and mint a qURL              |
| `upload_text_qurl`        | `qurl:write`   | Render text to PDF, upload it, and mint a qURL          |

## Commit Convention (Release Please)

This repository uses [Release Please](https://github.com/googleapis/release-please) for automated releases. Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) format.

### Format

```
type(scope): description
```

### Commit Types and Version Impact

| Type       | Description                             | Version Bump      |
| ---------- | --------------------------------------- | ----------------- |
| `feat`     | New feature                             | **Minor** (0.X.0) |
| `fix`      | Bug fix                                 | **Patch** (0.0.X) |
| `docs`     | Documentation only                      | None              |
| `style`    | Code style (formatting)                 | None              |
| `refactor` | Code change that neither fixes nor adds | None              |
| `perf`     | Performance improvement                 | **Patch**         |
| `test`     | Adding or updating tests                | None              |
| `build`    | Build system or dependencies            | None              |
| `ci`       | CI configuration                        | None              |
| `chore`    | Maintenance tasks                       | None              |

### Breaking Changes (Major Version)

Use `!` after the type or add `BREAKING CHANGE:` in the footer:

```bash
feat(tools)!: rename resolve_qurl to resolve tool
```

### Scopes

| Scope       | Component                                                  |
| ----------- | ---------------------------------------------------------- |
| `tools`     | MCP tool implementations                                   |
| `client`    | API client                                                 |
| `resources` | MCP resources                                              |
| `prompts`   | MCP prompts                                                |
| `http`      | HTTP transport, public routes, and remote-server lifecycle |
| `ci`        | GitHub Actions workflows                                   |
| `deps`      | Dependencies                                               |

> Keep this table aligned with the Component dropdown in
> `.github/ISSUE_TEMPLATE/bug_report.yml`. Convention only (not CI-
> enforced in this repo); add a new scope to both places in the same
> PR. The dropdown's `other` option is a reporter-UX escape hatch —
> do NOT add it here (it's not a valid commit scope).

## API Spec Maintenance

The repository includes an API spec drift detection system:

- **Snapshot:** `api-spec/qurls.yaml` contains the current API spec that the MCP tools are built against.
- **Workflow:** `.github/workflows/api-spec-check.yml` runs weekly (Monday 9am UTC) and on manual dispatch.
- **Detection:** The workflow fetches the live spec, diffs it against the snapshot, and opens a GitHub Issue with the diff when changes are detected.
- **Action:** When an issue is opened, review the diff, update `api-spec/qurls.yaml`, update client types/tools as needed, and verify with `npm run build && npm run lint && npm test`.
- **Spec URL:** Configurable via the `QURL_API_SPEC_URL` repository variable. Defaults to `https://api.layerv.ai/v1/openapi.yaml`.

## npm Publishing (Trusted Publishing / OIDC)

- The `publish` job in `.github/workflows/release-please.yml` publishes to npm via **OIDC trusted publishing — there is no `NODE_AUTH_TOKEN`/`NPM_TOKEN`.** Do **not** re-add a token when debugging a publish failure; npm authenticates via the trusted publisher using the job's `id-token: write`.
- **npmjs.com prerequisite:** a trusted publisher must be configured for `@layervai/qurl-mcp` (provider GitHub Actions, repo `layervai/qurl-mcp`, workflow `release-please.yml`, environment `npm-publish`). A mismatch (or a missing config) surfaces only at publish time on a tagged release, as `E404`/`ENEEDAUTH` — there is no token fallback.
- The job pins `npm@11.10.0` before publishing because trusted publishing needs npm ≥ 11.5.1 and Node 22 bundles npm 10.x. Keep this in sync with the `@layervai/qurl` SDK's pinned npm.
- This mirrors the SDK repo (`layervai/qurl-typescript`), which uses the same trusted-publishing setup.

## MCP Registry

- **Manifest:** `server.json` (validated against the registry's JSON Schema). Both `$.version` and `$.packages[0].version` are kept in sync with `package.json` automatically by release-please's `extra-files` config.
- **Auto-publish:** the `publish-mcp-registry` job in `.github/workflows/release-please.yml` runs after the npm publish on every release-please-created release. Uses GitHub OIDC for keyless auth (no PATs).
- **Manual publish:** `.github/workflows/publish-mcp-registry.yml` is the `workflow_dispatch`-only escape hatch for republishing the current `main` (recovery, registry outage retry). Do not add `on: push: tags:` to it — release-please pushes the tag via `GITHUB_TOKEN`, and GitHub suppresses cross-workflow tag triggers from `GITHUB_TOKEN` to prevent recursion, so a tag-trigger here would never fire on a real release.
- **Description divergence:** `server.json.description` is intentionally shorter than `package.json.description` because the registry hard-caps descriptions at 100 characters. Don't "fix" by aligning them — keep the npm/site copy long-form, and the registry copy concise.
- **Pinning:** both workflows delegate to the composite action at `.github/actions/publish-mcp-registry/action.yml` — that's the single source of truth for the `mcp-publisher` version + sha256. Bump both fields together there; the workflows themselves only pin `actions/checkout`.
- **Concurrency:** both publish jobs share a `concurrency: { group: mcp-registry-publish, cancel-in-progress: false }`. `mcp-publisher publish` is not idempotent on the same version, so a manual republish that overlaps an in-flight release would error noisily — the group serializes them.

## Smithery

- **Manifest:** `smithery.yaml`. Powers smithery.ai's auto-detect import flow.
- **Hand-synced:** `configSchema` is kept in sync with `server.json.environmentVariables` by hand. Adding or renaming a shared/stdio env var means updating both manifests; there's no automated sync. HTTP-only listener variables do not belong in either manifest because both publish the stdio transport.
- **Default URLs duplicated:** `https://api.layerv.ai` appears in four places — `smithery.yaml`'s schema default, the `commandFunction` fallback, `server.json`'s `environmentVariables[].default`, and `src/config.ts` runtime default. If the production URL ever moves, all four move in lockstep. The duplication is deliberate (defense-in-depth against consumers that don't apply JSON Schema defaults).

## Security Notes

- Never commit API keys or secrets
- `QURL_API_KEY` is passed via environment variable, never hardcoded
- The client only communicates with the configured `QURL_API_URL` endpoint
