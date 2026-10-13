import { describe, expect, it, vi } from "vitest";
import { manageCridAccessTool, publishCridTool } from "../tools/consumer-access.js";
import { makeMockClient } from "./helpers.js";
import { ProtectedResource, QURLClient as SDKClient } from "@layervai/qurl";

const resource = {
  resource_id: "r_test1234567",
  crid: "a".repeat(60),
  private: true,
  consumer_access: { mode: "invite_only" as const, version: 1 },
  status: "active" as const,
  target_url: "https://example.com",
  created_at: "2026-10-11T00:00:00Z",
  expires_at: "2026-10-12T00:00:00Z",
};
describe("consumer access publisher tools", () => {
  it("keeps a failed receipt recoverable without leaking response secrets", async () => {
    const client = makeMockClient({
      protectUrl: vi.fn().mockResolvedValue({
        crid: resource.crid,
        details: { ...resource, private: false, invitation_token: "must-not-leak" },
      }),
    });
    const result = await publishCridTool(client).handler({
      target_url: resource.target_url,
      policy: resource.consumer_access,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(resource.crid);
    expect(JSON.stringify(result)).toContain("write may have been applied");
    expect(JSON.stringify(result)).toContain("before retrying");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(client.protectUrl).toHaveBeenCalledTimes(1);
  });
  it("rejects display IDs and version-zero existing grant approvals before writing", async () => {
    const client = makeMockClient();
    const tool = manageCridAccessTool(client);
    expect(
      (
        await tool.handler({
          action: "invite",
          resource_id: "q_123456789ab",
          email: "ana@example.com",
        })
      ).isError,
    ).toBe(true);
    expect(client.inviteConsumer).not.toHaveBeenCalled();
    expect(
      (
        await tool.handler({
          action: "approve",
          resource_id: resource.crid,
          id: "a".repeat(64),
          approval: { expected_version: 0 },
        })
      ).isError,
    ).toBe(true);
    expect(client.approveConsumerGrant).not.toHaveBeenCalled();
  });

  it("accepts new credential approval at version zero", async () => {
    const client = makeMockClient({
      approveConsumerGrant: vi
        .fn()
        .mockResolvedValue({ id: "a".repeat(64), status: "active", version: 1 }),
    });
    expect(
      (
        await manageCridAccessTool(client).handler({
          action: "approve",
          resource_id: resource.crid,
          id: "new",
          approval: { expected_version: 0 },
        })
      ).isError,
    ).not.toBe(true);
    expect(client.approveConsumerGrant).toHaveBeenCalledWith(resource.crid, "new", {
      expected_version: 0,
    });
  });

  it("strips added output policy fields while keeping strict input policies", async () => {
    const client = makeMockClient({
      updateResource: vi.fn().mockResolvedValue({
        data: {
          ...resource,
          consumer_access: { ...resource.consumer_access, invitation_token: "must-not-leak" },
        },
      }),
    });
    const result = await manageCridAccessTool(client).handler({
      action: "configure",
      resource_id: resource.crid,
      expected_version: 0,
      policy: resource.consumer_access,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(
      (
        await publishCridTool(client).handler({
          target_url: resource.target_url,
          policy: { mode: "contract", version: 1 },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await publishCridTool(client).handler({
          target_url: resource.target_url,
          policy: { ...resource.consumer_access, contract_id: "wrong" },
        })
      ).isError,
    ).toBe(true);
    expect(client.protectUrl).not.toHaveBeenCalled();
  });

  it("reports a policy mismatch as a possibly applied update", async () => {
    const client = makeMockClient({
      updateResource: vi.fn().mockResolvedValue({
        data: {
          ...resource,
          consumer_access: { mode: "contract", version: 1, contract_id: "other" },
        },
      }),
    });
    const result = await manageCridAccessTool(client).handler({
      action: "configure",
      resource_id: resource.crid,
      expected_version: 0,
      policy: { mode: "contract", version: 1, contract_id: "requested" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      "the update may have been applied. Re-read the resource before retrying",
    );
  });

  it("preserves new server receipt statuses without exposing added fields", async () => {
    const client = makeMockClient({
      inviteConsumer: vi.fn().mockResolvedValue({
        id: "a".repeat(64),
        email: "ana@example.com",
        status: "open",
        delivery: "delayed",
        version: 1,
        expires_at: resource.expires_at,
        invitation_token: "must-not-leak",
      }),
    });
    const result = await manageCridAccessTool(client).handler({
      action: "invite",
      resource_id: resource.crid,
      email: "ana@example.com",
    });
    expect(result.structuredContent).toMatchObject({ invitation: { delivery: "delayed" } });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  it("configures the first policy with version zero without weakening decision versions", async () => {
    const client = makeMockClient({
      updateResource: vi.fn().mockResolvedValue({ data: resource }),
    });
    const tool = manageCridAccessTool(client);
    const result = await tool.handler({
      action: "configure",
      resource_id: resource.crid,
      expected_version: 0,
      policy: resource.consumer_access,
    });
    expect(result.isError).not.toBe(true);
    expect(client.updateResource).toHaveBeenCalledWith(resource.crid, {
      consumer_access: resource.consumer_access,
      expected_consumer_access_version: 0,
    });
    const refused = await tool.handler({
      action: "revoke_grant",
      resource_id: resource.crid,
      id: "a".repeat(64),
      expected_version: 0,
    });
    expect(refused.isError).toBe(true);
    expect(client.revokeConsumerGrant).not.toHaveBeenCalled();
  });
  it("publishes through the SDK helper and emits only resource metadata", async () => {
    const client = makeMockClient({
      protectUrl: vi
        .fn()
        .mockResolvedValue(
          new ProtectedResource(
            new SDKClient({ apiKey: "lv_test" }),
            resource.crid,
            resource.target_url,
            Object.assign({}, resource, { invitation_token: "must-not-leak" }),
          ),
        ),
    });
    const result = await publishCridTool(client).handler({
      target_url: resource.target_url,
      policy: resource.consumer_access,
    });
    expect(client.protectUrl).toHaveBeenCalledWith(resource.target_url, {
      consumerAccess: resource.consumer_access,
    });
    expect(result.structuredContent).toEqual({
      resource_id: resource.resource_id,
      crid: resource.crid,
      private: true,
      consumer_access: resource.consumer_access,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  it("rejects action fields that do not belong to an invitation", async () => {
    const client = makeMockClient();
    const result = await manageCridAccessTool(client).handler({
      action: "invite",
      resource_id: resource.resource_id,
      email: "ana@example.com",
      expected_version: 1,
    });
    expect(result.isError).toBe(true);
    expect(client.inviteConsumer).not.toHaveBeenCalled();
  });
  it("keeps removal pending and strips invitation secrets", async () => {
    const reply = {
      id: "a".repeat(64),
      email: "ana@example.com",
      status: "revoked",
      version: 2,
      delivery: "accepted",
      expires_at: resource.expires_at,
      session_cleanup: "pending",
      invitation_token: "must-not-leak",
    };
    const client = makeMockClient({ revokeConsumerInvitation: vi.fn().mockResolvedValue(reply) });
    const result = await manageCridAccessTool(client).handler({
      action: "revoke_invitation",
      resource_id: resource.resource_id,
      id: reply.id,
      expected_version: 1,
    });
    expect(result.structuredContent).toMatchObject({ invitation: { session_cleanup: "pending" } });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  it("passes opaque entitlement receipts without inventing payment verification", async () => {
    const client = makeMockClient({
      approveConsumerGrant: vi.fn().mockResolvedValue({
        id: "a".repeat(64),
        status: "active",
        version: 2,
        entitlement_id: "receipt-1",
        expires_at: resource.expires_at,
      }),
    });
    const approval = {
      expected_version: 1,
      entitlement_id: "receipt-1",
      expires_at: resource.expires_at,
    };
    await manageCridAccessTool(client).handler({
      action: "approve",
      resource_id: resource.resource_id,
      id: "a".repeat(64),
      approval,
    });
    expect(client.approveConsumerGrant).toHaveBeenCalledWith(
      resource.resource_id,
      "a".repeat(64),
      approval,
    );
  });
});
