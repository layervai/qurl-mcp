import { describe, expect, it } from "vitest";
import { readApiSpec } from "./helpers.js";

const spec = readApiSpec();

// Mirror the public operations in qurl-go's digest-bound
// tests/e2e/nativeudp/retired_lifecycle_surface.json contract.
// Only bootstrap appeared in this older snapshot; the other two guards keep a
// later service-spec refresh from importing either retired operation.
const retiredPublicLifecycleOperations = [
  {
    path: "/v1/agent/bootstrap",
    operationId: "postV1AgentBootstrap",
  },
  {
    path: "/v1/agent/registration-info",
    operationId: "getV1AgentRegistrationInfo",
  },
  {
    path: "/v1/agent/registration/complete",
    operationId: "postV1AgentRegistrationComplete",
  },
] as const;

const retiredLifecycleSchemas = [
  "AgentBootstrapRequest",
  "AgentBootstrapData",
  "AgentBootstrapResponse",
  "AgentRegistrationInfoData",
  "AgentRegistrationInfoResponse",
  "AgentRegistrationCompleteRequest",
  "AgentRegistrationCompleteData",
  "AgentRegistrationCompleteResponse",
  "NHPServerPeerInfo",
] as const;

describe("native UDP lifecycle API snapshot", () => {
  for (const operation of retiredPublicLifecycleOperations) {
    it(`does not export retired HTTP operation ${operation.operationId}`, () => {
      expect(spec).not.toContain(operation.path);
      expect(spec).not.toContain(operation.operationId);
    });
  }

  for (const schema of retiredLifecycleSchemas) {
    it(`does not export retired HTTP lifecycle schema ${schema}`, () => {
      expect(spec).not.toContain(schema);
    });
  }

  it("retains qurl:agent for native UDP enrollment credential minting", () => {
    expect(spec).toContain(
      "- `qurl:agent` - Mint native UDP qURL Connector enrollment credentials",
    );
    expect(spec).toContain("qurl:agent: Mint native UDP qURL Connector enrollment credentials");
    expect(spec).not.toContain("- `qurl:agent` - Bootstrap LayerV qURL Connector agents");
    expect(spec).not.toContain("qurl:agent: Bootstrap LayerV qURL Connector agents");
  });
});
