# Changelog

## [0.9.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.9.0...qurl-mcp-v0.9.1) (2026-11-01)


### Bug Fixes

* **tools:** show tool purposes first in compact catalogs ([#370](https://github.com/layervai/qurl-mcp/issues/370)) ([e3d6d6b](https://github.com/layervai/qurl-mcp/commit/e3d6d6b33a4360603b5338c4e60530e98d6e8e32))

## [0.9.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.8.3...qurl-mcp-v0.9.0) (2026-10-31)


### Features

* allow operators to restrict connector link hosts ([#363](https://github.com/layervai/qurl-mcp/issues/363)) ([5770531](https://github.com/layervai/qurl-mcp/commit/5770531bf3ae15b5eef79bf402080134227d7ee4))
* **http:** validate hosted OAuth and delegate per user ([#354](https://github.com/layervai/qurl-mcp/issues/354)) ([2f11077](https://github.com/layervai/qurl-mcp/commit/2f11077d51ce7c4dc9356ef90095f4ce64eb2a43))
* mint file links from stored uploads without uploading again ([#364](https://github.com/layervai/qurl-mcp/issues/364)) ([4ad14ad](https://github.com/layervai/qurl-mcp/commit/4ad14ad7c496b671f0af66111d1981be1c02c6da))
* **tools:** send MCP feedback to Slack for human review ([#369](https://github.com/layervai/qurl-mcp/issues/369)) ([c5fa8e7](https://github.com/layervai/qurl-mcp/commit/c5fa8e71df16ac1bf022ff0bf86f0d8011ac6521))


### Bug Fixes

* **http:** separate OAuth access reads from changes ([#356](https://github.com/layervai/qurl-mcp/issues/356)) ([0112567](https://github.com/layervai/qurl-mcp/commit/01125674e5a4f039414465ca7ff4da637de53a60))
* match producer duration precision and add contract corpus ([#368](https://github.com/layervai/qurl-mcp/issues/368)) ([abf2ca5](https://github.com/layervai/qurl-mcp/commit/abf2ca53875deb87ea8a310777a72fcb5951663a))
* report status coercion while preserving tool schemas ([#361](https://github.com/layervai/qurl-mcp/issues/361)) ([244490d](https://github.com/layervai/qurl-mcp/commit/244490d1d8337dd4acb12cecb199599a10f2951c))

## [0.8.3](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.8.2...qurl-mcp-v0.8.3) (2026-10-25)


### Bug Fixes

* **tools:** return usable local management IDs and clarify invitations ([#350](https://github.com/layervai/qurl-mcp/issues/350)) ([09d9980](https://github.com/layervai/qurl-mcp/commit/09d998038e1a10edb054b7a57eced4c13b624cb6))

## [0.8.2](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.8.1...qurl-mcp-v0.8.2) (2026-10-25)


### Bug Fixes

* **deps:** apply authorized body-parser security age exception ([#348](https://github.com/layervai/qurl-mcp/issues/348)) ([c251009](https://github.com/layervai/qurl-mcp/commit/c251009d8c3fd421e71b144a37de5db11cb03625))
* **deps:** update vulnerable validation dependencies ([#342](https://github.com/layervai/qurl-mcp/issues/342)) ([2bf9bf7](https://github.com/layervai/qurl-mcp/commit/2bf9bf75c0f6170ece33338a12e394eee6f43d8b))
* **tools:** guide existing review approvals and reject mixed credential inputs ([#349](https://github.com/layervai/qurl-mcp/issues/349)) ([56c3a78](https://github.com/layervai/qurl-mcp/commit/56c3a787b7eae5d3299ce6ef4cb834cddba56f07))

## [0.8.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.8.0...qurl-mcp-v0.8.1) (2026-10-24)


### Bug Fixes

* **tools:** distinguish consumer policies from legacy MCP access ([#340](https://github.com/layervai/qurl-mcp/issues/340)) ([6af6dd9](https://github.com/layervai/qurl-mcp/commit/6af6dd9d78258e6cb1673b2c316d3669af1e75ce))

## [0.8.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.7.2...qurl-mcp-v0.8.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **tools:** require public app names for local publishing ([#326](https://github.com/layervai/qurl-mcp/issues/326))

### Features

* **tools:** require public app names for local publishing ([#326](https://github.com/layervai/qurl-mcp/issues/326)) ([aec8d86](https://github.com/layervai/qurl-mcp/commit/aec8d8637b618cfd37fe3bcfab5839aa8cffc768))


### Bug Fixes

* **docker:** remove npm build tools from runtime image ([#339](https://github.com/layervai/qurl-mcp/issues/339)) ([31e9eae](https://github.com/layervai/qurl-mcp/commit/31e9eae58a5056c3bf9054a361fee7246ee00a05))

## [0.7.2](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.7.1...qurl-mcp-v0.7.2) (2026-10-18)


### Bug Fixes

* **tools:** accept verified email grant receipts ([#324](https://github.com/layervai/qurl-mcp/issues/324)) ([369c1c7](https://github.com/layervai/qurl-mcp/commit/369c1c7e302c692ee2b2d8de9d5ee97984fbfa64))

## [0.7.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.7.0...qurl-mcp-v0.7.1) (2026-10-18)


### Bug Fixes

* **deps:** repair vulnerable production lock entries ([#321](https://github.com/layervai/qurl-mcp/issues/321)) ([ee382fe](https://github.com/layervai/qurl-mcp/commit/ee382fe6eb1926b87e739fe3f0237d1f6dc3c6ea))
* **deps:** update Nodemailer for parser and TLS fixes ([#320](https://github.com/layervai/qurl-mcp/issues/320)) ([9d6a20d](https://github.com/layervai/qurl-mcp/commit/9d6a20de16f19a99fc61b5b2d4fb8221c053d796))
* **local:** set and confirm public app names when publishing ([#318](https://github.com/layervai/qurl-mcp/issues/318)) ([f5c18d6](https://github.com/layervai/qurl-mcp/commit/f5c18d6b66178c3102ce38b3ac933de87004aebd))

## [0.7.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.6.0...qurl-mcp-v0.7.0) (2026-10-14)


### Features

* **tools:** run stdio without an account through the local qURL CLI ([#316](https://github.com/layervai/qurl-mcp/issues/316)) ([5c90e0c](https://github.com/layervai/qurl-mcp/commit/5c90e0ccaedaea6207961a7e431560a29e7bdebf))

## [0.6.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.5.0...qurl-mcp-v0.6.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **tools:** Node.js 22.12 or later is required by SDK 3.0.0; Node.js 20 is no longer supported. Add private CRID publishing and access tools ([#313](https://github.com/layervai/qurl-mcp/issues/313)).
* align MCP quota contract with unlimited resource links ([#289](https://github.com/layervai/qurl-mcp/issues/289))
* **tools:** extend_qurl now extends the link, not the resource, and requires qurl:read in addition to qurl:write (a write-only key now fails before any change). Upload tools mint links through the connector's /api/mint_link (links cannot be revoked from this server yet, #281), reject access_policy and max_sessions (uploaded files can no longer carry an access policy or session cap in any connector mode, including legacy ones where minting on the upload resource used to apply them), bound expires_in to 1m-30d (default 24h) and session_duration to whole seconds from 1s-24h, make qurl_id optional in the result (omitted when the connector reports none), and drop qurl_site/branded_domain/type from it. update_qurl and update_qurl_token bound extend_by locally (create_qurl and mint_link keep API-side duration validation, #282). Duration inputs accept unsigned Go-unit sequences or whole days/weeks and reject leading signs, leading-dot fractions, and Greek mu. IQURLClient.extendQURL is removed; use updateQurlToken.

### Features

* **tools:** add CRID-based qURL link sharing ([#272](https://github.com/layervai/qurl-mcp/issues/272)) ([3f7a020](https://github.com/layervai/qurl-mcp/commit/3f7a020d15f82d7042ed5a74dc09ea0bca045b8c))
* **tools:** add private CRID publishing and access tools ([#313](https://github.com/layervai/qurl-mcp/issues/313)) ([a56cb18](https://github.com/layervai/qurl-mcp/commit/a56cb18afc063a0883db979f72220c36db566d1d))


### Bug Fixes

* align MCP quota contract with unlimited resource links ([#289](https://github.com/layervai/qurl-mcp/issues/289)) ([425d3d9](https://github.com/layervai/qurl-mcp/commit/425d3d94765e5a2a0f6d8db67217b76e73c6d0ae))
* **tools:** mint upload links through the connector and extend the link, not the resource ([0717190](https://github.com/layervai/qurl-mcp/commit/071719055425d0cdd686b3a098603e39987df27b))

## [0.5.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.4.1...qurl-mcp-v0.5.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **http:** Hosted operators must set MCP_SERVE_LAYERV_LEGAL_PAGES=true to retain LayerV legal routes. HTTP SMTP delivery now requires the caller to use the configured QURL_API_KEY operator credential. Apply hosted configuration with the current image digest before upgrading the application.

### Features

* add remote MCP transport and sharing workflows ([#182](https://github.com/layervai/qurl-mcp/issues/182)) ([4049006](https://github.com/layervai/qurl-mcp/commit/40490061dffd63fcf09ec9374eb8cc8b182fc142))
* **http:** add autoscaling-safe stateless runtime ([#198](https://github.com/layervai/qurl-mcp/issues/198)) ([8388183](https://github.com/layervai/qurl-mcp/commit/8388183e67bd7614a702d0c22c6c2810eae81ede))


### Bug Fixes

* **client:** clarify resource status and verify SDK retries ([#273](https://github.com/layervai/qurl-mcp/issues/273)) ([607c69d](https://github.com/layervai/qurl-mcp/commit/607c69db20ae6b8b36d108990f625e591f0bb874))
* **http:** prevent pending-slot starvation and restrict hosted SMTP ([#275](https://github.com/layervai/qurl-mcp/issues/275)) ([c73e780](https://github.com/layervai/qurl-mcp/commit/c73e780951c8b0ea55fb5d0d1f66e976fb398319))
* prepare installed binaries and packaging for 0.5.0 ([#274](https://github.com/layervai/qurl-mcp/issues/274)) ([784472d](https://github.com/layervai/qurl-mcp/commit/784472d5812fca27915b1f6b03e11ddf9d0e57f6))
* **tools:** restore API compatibility and safe sharing for release ([#276](https://github.com/layervai/qurl-mcp/issues/276)) ([7582430](https://github.com/layervai/qurl-mcp/commit/758243030f0929da3bb94d64fc2925e4f7bc8a6f))

## [0.4.1](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.4.0...qurl-mcp-v0.4.1) (2026-06-13)


### Features

* **client:** use the @layervai/qurl SDK instead of the hand-rolled client ([#157](https://github.com/layervai/qurl-mcp/issues/157)) ([63faacd](https://github.com/layervai/qurl-mcp/commit/63faacd691c3effe38a5d78b3df903cea75877cc))
* sync qurl-service API contract ([#148](https://github.com/layervai/qurl-mcp/issues/148)) ([9076313](https://github.com/layervai/qurl-mcp/commit/907631344f3a9323a777d9c590afef7a3f03ee70))


### Bug Fixes

* **deps:** replace removed z.AnyZodObject with z.ZodObject for zod v4 ([#133](https://github.com/layervai/qurl-mcp/issues/133)) ([c367ef8](https://github.com/layervai/qurl-mcp/commit/c367ef8b6ed4a42304eb1b76b6dd77789fe63188))
* **tools:** close items 1 and 3 from issue [#83](https://github.com/layervai/qurl-mcp/issues/83) follow-ups ([#100](https://github.com/layervai/qurl-mcp/issues/100)) ([48b55e5](https://github.com/layervai/qurl-mcp/commit/48b55e57179d572df494b9cc4245bb26c83e8bb0))

## [0.4.0](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.3.4...qurl-mcp-v0.4.0) (2026-04-29)


### ⚠ BREAKING CHANGES

* The npm package name has changed from `@layerv/qurl-mcp` to `@layervai/qurl-mcp`. Existing users must update their MCP client config — replace the package identifier in the `args` array. No code, env vars, API keys, or tool surface changed; this is a pure rename. The `@layerv/qurl-mcp` package on npm will be deprecated post-release with `npm deprecate "@layerv/qurl-mcp@*" "moved to @layervai/qurl-mcp"` so existing installs surface a migration warning.

### Features

* rename npm package from @layerv/qurl-mcp to @layervai/qurl-mcp ([#92](https://github.com/layervai/qurl-mcp/issues/92)) ([1724a74](https://github.com/layervai/qurl-mcp/commit/1724a749ce481ea93005490a0229c6fc38ed901d))

## [0.3.4](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.3.3...qurl-mcp-v0.3.4) (2026-04-28)


### Bug Fixes

* **tools:** add custom_domain + preserve_host to update_qurl input ([#88](https://github.com/layervai/qurl-mcp/issues/88)) ([38769db](https://github.com/layervai/qurl-mcp/commit/38769dbd89a4dcae3cb9941dc6739764a2ce1e74))

## [0.3.3](https://github.com/layervai/qurl-mcp/compare/qurl-mcp-v0.3.2...qurl-mcp-v0.3.3) (2026-04-28)


### Bug Fixes

* **client:** add preserve_host to QURL interface and qurlSchema ([#85](https://github.com/layervai/qurl-mcp/issues/85)) ([b8e82da](https://github.com/layervai/qurl-mcp/commit/b8e82dadb52457ee7c24fadceedfa101cfedf184))

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
