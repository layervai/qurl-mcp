# API contract maintenance

`qurls.yaml` is the API snapshot used by the tools. The weekly spec check compares
it with the published API reference.

`duration-contract.json` ties the MCP duration validator to the producer. It holds
all four expiry/session bounds, expected results from the real Go parser, and
fingerprints of the producer parser and its Go standard-library duration code.
The MCP tests check this corpus against `parseDurationMs`. Run the producer's
`TestMCPDurationContract` with this JSON weekly and on relevant PRs to check the
actual parser and constants. Read the public JSON as data only; do not execute
MCP code in the private producer checkout.

When the producer changes, audit the grammar and bounds before updating this
file. Generate `upstream_ms` with the actual producer, not the MCP parser.
`mcp_ms: null` records the deliberate unsigned subset; a non-null magnitude above
the local bounds can still be rejected by range validation. Keep fractional,
overflow, day/week, compound, and syntax-rejection cases. Fingerprints cover
normalized Go AST nodes, so comment-only changes do not require an update.
