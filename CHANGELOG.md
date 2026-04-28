# Changelog

## [0.3.2](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.3.1...qurl-mcp-v0.3.2) (2026-04-28)


### Features

* **tools:** add output schemas, annotations, and richer descriptions for TDQS ([#82](https://github.com/layervai/qurl-mcp/issues/82)) ([1a675ef](https://github.com/layervai/qurl-mcp/commit/1a675efd97ce74022c49ef3236b34b40dfca5905))

## [0.3.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.3.0...qurl-mcp-v0.3.1) (2026-04-27)


### Bug Fixes

* include LICENSE in published npm tarball ([#80](https://github.com/layervai/qurl-mcp/issues/80)) ([d51f923](https://github.com/layervai/qurl-mcp/commit/d51f9239d0e581491226eb13a4bf31cbd6ccf39c))

## [0.3.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.2.0...qurl-mcp-v0.3.0) (2026-04-27)


### ⚠ BREAKING CHANGES

* server no longer exits at boot when QURL_API_KEY is unset. Misconfiguration is now signaled via a stderr warning at startup and a typed missing_api_key error from every QURLClient request, surfaced through MCP as an isError content block (tools) or error JSON (resources). Process supervisors that watched for non-zero exit on missing config will need to switch to detecting the per-call error or grepping the boot-time stderr warning. Some MCP hosts (notably older Claude Desktop releases) hide stderr — those users will see the failure only on first tool/resource invocation.

### Features

* add Dockerfile + Glama prep + defer QURL_API_KEY validation ([#71](https://github.com/layervai/qurl-mcp/issues/71)) ([e1688a1](https://github.com/layervai/qurl-mcp/commit/e1688a1c006b2c961f07641da44ceab6da6d436e))
* register with MCP Registry ([#70](https://github.com/layervai/qurl-mcp/issues/70)) ([722acd4](https://github.com/layervai/qurl-mcp/commit/722acd45989e1cfe6f2440d554d75c599ef08715))

## [0.2.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.1.2...qurl-mcp-v0.2.0) (2026-04-27)


### ⚠ BREAKING CHANGES

* **deps:** TypeScript 6.0 no longer implicitly includes Node.js type definitions. Added explicit `"types": ["node"]` to tsconfig.json.
* extend_qurl tool renamed to update_qurl. QURL response shape changed (removed qurl_link, access_count, metadata from get/list responses). Create endpoint path changed from /v1/qurl to /v1/qurls.

### Features

* align QURL type with API identity fix ([#37](https://github.com/layervai/qurl-mcp/issues/37)) ([fccf4f7](https://github.com/layervai/qurl-mcp/commit/fccf4f78c96d19f1f8dc82f1b6ac4e9227233b9f))
* **ci:** add fleet issue-template + priority-enforcement pattern ([#63](https://github.com/layervai/qurl-mcp/issues/63)) ([58bd30d](https://github.com/layervai/qurl-mcp/commit/58bd30daf930fdf09c022924d800ba58b851a0db))
* **deps:** upgrade TypeScript 5.x -&gt; 6.0.2 ([#50](https://github.com/layervai/qurl-mcp/issues/50)) ([e12b15f](https://github.com/layervai/qurl-mcp/commit/e12b15f368e27029abc720174c471dcab6ba16e9))
* update client, tools, and prompts for latest API spec ([#28](https://github.com/layervai/qurl-mcp/issues/28)) ([535bbb3](https://github.com/layervai/qurl-mcp/commit/535bbb35909187a7493a029a9dacc6b9ca1bb36f))


### Bug Fixes

* **ci:** pin all GitHub Actions to commit SHAs ([#42](https://github.com/layervai/qurl-mcp/issues/42)) ([b2367f6](https://github.com/layervai/qurl-mcp/commit/b2367f6350c2eb328fba56536af115ed51d8225c))
* **ci:** polish Slack notification — rename header, deduplicate, consistency ([#40](https://github.com/layervai/qurl-mcp/issues/40)) ([66d0969](https://github.com/layervai/qurl-mcp/commit/66d0969098cdac7ae0b4bcaed125b59d97f48ab2))

## [0.1.2](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.1.1...qurl-mcp-v0.1.2) (2026-03-11)


### Features

* **prompts:** add MCP prompts for guided QURL workflows ([#17](https://github.com/layervai/qurl-mcp/issues/17)) ([a89609d](https://github.com/layervai/qurl-mcp/commit/a89609de4e890ebeb7df935dd73b0768e42f916a))


### Bug Fixes

* **deps:** add repository URL for npm provenance ([#19](https://github.com/layervai/qurl-mcp/issues/19)) ([c5536f1](https://github.com/layervai/qurl-mcp/commit/c5536f1f6dcc4b8b7ca7fa4355826668b9058342))

## [0.1.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.1.0...qurl-mcp-v0.1.1) (2026-03-10)


### Features

* initial MCP server for QURL ([a6eac05](https://github.com/layervai/qurl-mcp/commit/a6eac05dea72c3e30183e6c5668b1e1b84c15102))


### Bug Fixes

* **ci:** update claude-code-review to use correct action inputs ([#15](https://github.com/layervai/qurl-mcp/issues/15)) ([efba4b5](https://github.com/layervai/qurl-mcp/commit/efba4b5b593aac46c729132bbe16b68088c95185))
* **client:** correct Content-Type, limit check, metadata schema, and tool output ([#16](https://github.com/layervai/qurl-mcp/issues/16)) ([015d5ab](https://github.com/layervai/qurl-mcp/commit/015d5ab663a54623372f1e2f4e832a8f2edc6dc8))
