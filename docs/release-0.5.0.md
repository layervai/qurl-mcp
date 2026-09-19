# 0.5.0 release handoff

Merge the readiness fixes before approving release PR #195. The release-please
configuration now treats pre-1.0 features as minor releases, so the pending
0.4.2 proposal should regenerate as 0.5.0 on the next main push. Do not manually
bump package.json, the manifest, or server.json in a readiness PR. Verify the
regenerated release updates package.json, package-lock.json, the release manifest,
and both server.json version fields, and includes every merged fix before a
human merges it.

Use this summary when reviewing the generated release notes:

- Authenticated Streamable HTTP transport alongside stdio, with request-scoped
  API credentials, bounded sessions and rate limits, Host/proxy validation, and
  optional stateless operation for multiple replicas.
- File, base64 attachment, and text-to-PDF upload workflows through the optional
  connector. Server-local file access remains stdio-only.
- Optional SMTP sharing with recipient policy, delivery quotas, and credential
  redaction; public legal pages and optional video pages for hosted deployments.
- Hardened input, upload, PDF, authentication, and error-handling boundaries.
  Existing resource/token/session management tools remain available.
- npm/npx-installed entry points execute correctly through bin symlinks; the
  bundled regular-weight TrueType font preserves offline CJK PDF support with a
  smaller package. Weekly spec checks fail visibly on retrieval errors.

The release workflow already checks out the release tag, publishes npm through
OIDC, then publishes the same version to MCP Registry through its shared pinned
composite action. No registry workflow repair or manual registry publish is
needed for this release. The npm trusted-publisher configuration must continue
to match the repository, workflow, and `npm-publish` environment.

Publishing is a separate human-controlled step: merging the release PR creates
the tag and triggers npm/registry publication. This handoff does not authorize
merging or publishing. Keep Node >=20 and the current SDK major unchanged.
