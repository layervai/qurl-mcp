import { z } from "zod";
import { QURLAPIError, type IQURLClient } from "../client.js";
import {
  resourceIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const policy = z
  .object({
    mode: z.enum(["keys", "invite_only", "email_capture", "review", "contract"]),
    version,
    contract_id: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const validPolicy = policy.refine(
  (p) => (p.mode === "contract") === (p.contract_id !== undefined),
  "Only contract access requires a contract identifier",
);
const resource = z.object({
  resource_id: z.string(),
  crid: z.string(),
  private: z.literal(true),
  consumer_access: policy,
});
const invitation = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(["open", "enrolled", "revoked"]),
  delivery: z.enum(["queued", "accepted", "failed"]),
  version,
  expires_at: z.string(),
  session_cleanup: z.enum(["pending", "complete"]).optional(),
});
const grant = z.object({
  id: z.string(),
  status: z.enum(["pending", "active", "revoked"]),
  version,
  credential_kind: z.enum(["passkey", "device"]).optional(),
  credential_id: z.string().optional(),
  credential_public_key_b64: z.string().optional(),
  email: z.string().optional(),
  email_verified_at: z.string().optional(),
  entitlement_id: z.string().optional(),
  expires_at: z.string().optional(),
  session_cleanup: z.enum(["pending", "complete"]).optional(),
});
const publishInput = z.object({ target_url: z.string().url(), policy: validPolicy }).strict();

export function publishCridTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "publish_crid",
    title: "Publish a private CRID",
    description:
      "Publish a URL with private access. Choose keys for approved credentials, invite_only for publisher email invitations with no access requests, email_capture for verified email capture with consent, review for verified email requests, or contract for a publisher backend entitlement receipt. This tool does not verify payment. Use version 1 for creation. For local apps use the qURL CLI. Public sharing uses create_qurl.",
    inputSchema: publishInput,
    outputSchema: resource,
    annotations: {
      title: "Publish a private CRID",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof publishInput>) => {
      const parsed = publishInput.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const handle = await client.protectUrl(parsed.data.target_url, {
        consumerAccess: parsed.data.policy,
      });
      const data = resource.parse(handle.details);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: toStructuredContent(data),
      };
    }),
  };
}

const approval = z
  .object({
    expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    credential_kind: z.enum(["passkey", "device"]).optional(),
    credential_id: z.string().min(1).max(1024).optional(),
    credential_public_key_b64: z.string().min(1).max(1024).optional(),
    entitlement_id: z.string().min(1).max(256).optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const base = z
  .object({
    action: z.enum([
      "configure",
      "invite",
      "list_invitations",
      "resend",
      "revoke_invitation",
      "list_grants",
      "approve",
      "deny",
      "revoke_grant",
    ]),
    resource_id: resourceIdSchema("manage access"),
    policy: validPolicy.optional(),
    email: z.string().email().max(320).optional(),
    id: z.string().min(1).max(64).optional(),
    expected_version: version.optional(),
    approval: approval.optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const identity = z.object({ resource_id: resourceIdSchema("manage access") });
const decision = { id: z.string().regex(/^[a-f0-9]{64}$/), expected_version: version };
const page = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const actions = z.discriminatedUnion("action", [
  identity
    .extend({ action: z.literal("configure"), policy: validPolicy, expected_version: version })
    .strict(),
  identity.extend({ action: z.literal("invite"), email: z.string().email().max(320) }).strict(),
  identity.extend({ action: z.literal("list_invitations"), ...page }).strict(),
  identity.extend({ action: z.literal("list_grants"), ...page }).strict(),
  identity.extend({ action: z.literal("resend"), ...decision }).strict(),
  identity.extend({ action: z.literal("revoke_invitation"), ...decision }).strict(),
  identity
    .extend({
      action: z.literal("approve"),
      id: z.union([decision.id, z.literal("new")]),
      approval,
    })
    .strict(),
  identity.extend({ action: z.literal("deny"), ...decision }).strict(),
  identity.extend({ action: z.literal("revoke_grant"), ...decision }).strict(),
]);
const output = z
  .object({
    action: base.shape.action,
    resource: resource.optional(),
    invitation: invitation.optional(),
    grant: grant.optional(),
    invitations: z.array(invitation).optional(),
    grants: z.array(grant).optional(),
    next_cursor: z.string().optional(),
  })
  .strict();

export function manageCridAccessTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "manage_crid_access",
    title: "Manage private CRID access",
    description:
      "Publisher access control. Configure the next policy version, send or resend an email invitation, list invitations or consumer grants, approve or deny a request, approve a credential with id new, or revoke access. Read the current version before a decision. Invite-only access has no consumer requests. Contract approval requires a trusted publisher entitlement receipt and expiry, not an unverified payment claim. A removal is complete only when session_cleanup is complete; retry the same removal/version while pending. Email proves mailbox control, not legal identity. Only listed fields are returned; invitation secrets and bearer links are never returned.",
    inputSchema: base,
    outputSchema: output,
    annotations: {
      title: "Manage private CRID access",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof base>) => {
      const parsed = actions.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const input = parsed.data;
      let result: z.infer<typeof output> = { action: input.action };
      switch (input.action) {
        case "configure":
          result.resource = resource.parse(
            (
              await client.updateResource(input.resource_id, {
                consumer_access: input.policy,
                expected_consumer_access_version: input.expected_version,
              })
            ).data,
          );
          if (
            result.resource.consumer_access.mode !== input.policy.mode ||
            result.resource.consumer_access.version !== input.policy.version ||
            result.resource.consumer_access.contract_id !== input.policy.contract_id
          ) {
            throw new QURLAPIError(
              0,
              "invalid_response",
              "The service did not confirm the private access policy",
            );
          }
          break;
        case "invite":
          result.invitation = invitation.parse(
            await client.inviteConsumer(input.resource_id, input.email),
          );
          break;
        case "resend":
          result.invitation = invitation.parse(
            await client.resendConsumerInvitation(
              input.resource_id,
              input.id,
              input.expected_version,
            ),
          );
          break;
        case "revoke_invitation":
          result.invitation = invitation.parse(
            await client.revokeConsumerInvitation(
              input.resource_id,
              input.id,
              input.expected_version,
            ),
          );
          break;
        case "approve":
          result.grant = grant.parse(
            await client.approveConsumerGrant(input.resource_id, input.id, input.approval),
          );
          break;
        case "deny":
          result.grant = grant.parse(
            await client.denyConsumerGrant(input.resource_id, input.id, input.expected_version),
          );
          break;
        case "revoke_grant":
          result.grant = grant.parse(
            await client.revokeConsumerGrant(input.resource_id, input.id, input.expected_version),
          );
          break;
        case "list_invitations": {
          const reply = await client.listConsumerInvitations(input.resource_id, {
            cursor: input.cursor,
            limit: input.limit,
          });
          result.invitations = z.array(invitation).parse(reply.invitations);
          result.next_cursor = reply.next_cursor;
          break;
        }
        case "list_grants": {
          const reply = await client.listConsumerGrants(input.resource_id, {
            cursor: input.cursor,
            limit: input.limit,
          });
          result.grants = z.array(grant).parse(reply.grants);
          result.next_cursor = reply.next_cursor;
          break;
        }
      }
      result = output.parse(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: toStructuredContent(result),
      };
    }),
  };
}
