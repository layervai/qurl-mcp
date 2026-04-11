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

QURL MCP Server is a TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes QURL operations as tools for AI agents. It uses stdio transport and communicates with the QURL API.

## Architecture

```
qurl-mcp/
├── src/
│   ├── index.ts           # Entry point, env validation, stdio transport
│   ├── server.ts          # MCP server factory, tool/resource/prompt registration
│   ├── client.ts          # TypeScript QURL API client
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
│   │   └── batch-create.ts
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

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `QURL_API_KEY` | Yes | API key with `qurl:read`, `qurl:write`, and/or `qurl:resolve` scopes | — |
| `QURL_API_URL` | No | QURL API base URL | `https://api.layerv.ai` |

## MCP Usage

```json
{
  "mcpServers": {
    "qurl": {
      "command": "npx",
      "args": ["@layerv/qurl-mcp"],
      "env": { "QURL_API_KEY": "lv_live_xxx" }
    }
  }
}
```

## Tools

| Tool | Scope Required | Description |
|------|---------------|-------------|
| `create_qurl` | `qurl:write` | Create a protected link |
| `resolve_qurl` | `qurl:resolve` | Resolve token + open firewall |
| `list_qurls` | `qurl:read` | List QURLs with filtering |
| `get_qurl` | `qurl:read` | Get QURL details |
| `delete_qurl` | `qurl:write` | Revoke a QURL |
| `extend_qurl` | `qurl:write` | Extend expiration (shorthand alias for `update_qurl`) |
| `update_qurl` | `qurl:write` | Update expiration, tags, description |
| `mint_link` | `qurl:write` | Mint a new access link for an existing resource |
| `batch_create_qurls` | `qurl:write` | Create multiple QURLs at once |

## Commit Convention (Release Please)

This repository uses [Release Please](https://github.com/googleapis/release-please) for automated releases. Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) format.

### Format

```
type(scope): description
```

### Commit Types and Version Impact

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | **Minor** (0.X.0) |
| `fix` | Bug fix | **Patch** (0.0.X) |
| `docs` | Documentation only | None |
| `style` | Code style (formatting) | None |
| `refactor` | Code change that neither fixes nor adds | None |
| `perf` | Performance improvement | **Patch** |
| `test` | Adding or updating tests | None |
| `build` | Build system or dependencies | None |
| `ci` | CI configuration | None |
| `chore` | Maintenance tasks | None |

### Breaking Changes (Major Version)

Use `!` after the type or add `BREAKING CHANGE:` in the footer:

```bash
feat(tools)!: rename resolve_qurl to resolve tool
```

### Scopes

| Scope | Component |
|-------|-----------|
| `tools` | MCP tool implementations |
| `client` | API client |
| `resources` | MCP resources |
| `prompts` | MCP prompts |
| `ci` | GitHub Actions workflows |
| `deps` | Dependencies |

## API Spec Maintenance

The repository includes an API spec drift detection system:

- **Snapshot:** `api-spec/qurls.yaml` contains the current API spec that the MCP tools are built against.
- **Workflow:** `.github/workflows/api-spec-check.yml` runs weekly (Monday 9am UTC) and on manual dispatch.
- **Detection:** The workflow fetches the live spec, diffs it against the snapshot, and opens a GitHub Issue with the diff when changes are detected.
- **Action:** When an issue is opened, review the diff, update `api-spec/qurls.yaml`, update client types/tools as needed, and verify with `npm run build && npm run lint && npm test`.
- **Spec URL:** Configurable via the `QURL_API_SPEC_URL` repository variable. Defaults to `https://api.layerv.ai/v1/openapi.yaml`.

## Security Notes

- Never commit API keys or secrets
- `QURL_API_KEY` is passed via environment variable, never hardcoded
- The client only communicates with the configured `QURL_API_URL` endpoint
