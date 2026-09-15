# API snapshot maintenance

The source of truth is [qurl-service/api/openapi.yaml](https://github.com/layervai/qurl-service/blob/main/api/openapi.yaml).
This older snapshot includes targeted contract corrections; it is not a claim of byte-for-byte equality with the current service spec.

The 30-day customer link-lifetime descriptions come from [qurl-service #1511](https://github.com/layervai/qurl-service/pull/1511).
Deploy that service change before merging the companion snapshot correction [#271](https://github.com/layervai/qurl-mcp/pull/271).
A drift report against an older service must not restore the former 3-day Free limit: refresh from the updated source once deployed.
The snapshot expiry regression test preserves this policy across future refreshes; revise it if the customer policy deliberately changes.

These public API durations are capped at 30 days even for internal accounts. The internal System tier's longer allowance does not raise the HTTP validation ceiling.
