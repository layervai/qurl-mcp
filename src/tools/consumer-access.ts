import { z } from "zod";
import { QURLAPIError, type IQURLClient } from "../client.js";
import {
  resourceOnlyIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
  type ToolResult,
} from "./_shared.js";

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const initialVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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
  consumer_access: policy.strip(),
});
const invitation = z.object({
  id: z.string(),
  email: z.string(),
  status: z.string().min(1).max(64),
  delivery: z.string().min(1).max(64),
  version,
  expires_at: z.string(),
  session_cleanup: z.enum(["pending", "complete"]).optional(),
});
const grant = z.object({
  id: z.string(),
  status: z.string().min(1).max(64),
  version,
  credential_kind: z.enum(["passkey", "device", "email"]).optional(),
  credential_id: z.string().optional(),
  credential_public_key_b64: z.string().optional(),
  email: z.string().optional(),
  email_verified_at: z.string().optional(),
  entitlement_id: z.string().optional(),
  expires_at: z.string().optional(),
  session_cleanup: z.enum(["pending", "complete"]).optional(),
});
const publishInput = z.object({ target_url: z.string().url(), policy: validPolicy }).strict();

function receipt<T>(schema: z.ZodType<T>, value: unknown, resourceId: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new QURLAPIError(
      0,
      "access_receipt_unconfirmed",
      `The service returned an unrecognized access receipt. A write may have been applied; read resource ${resourceId} and list its access before retrying.`,
    );
  }
  return parsed.data;
}

export function publishCridTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "publish_crid",
    title: "Publish a private CRID",
    description:
      "Publish a URL with private access. Choose keys for approved credentials, invite_only for publisher email invitations with no access requests, email_capture for verified email capture with consent, review for verified email requests, or contract for a publisher backend entitlement receipt. This tool does not verify payment. Use version 1 for creation. Repeating this call creates another resource; after an uncertain result use get_qurl or list_qurls before retrying. For local apps use the qURL CLI. Public sharing uses create_qurl.",
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
      const data = receipt(resource, handle.details, handle.crid);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: toStructuredContent(data),
      };
    }),
  };
}

const approval = z
  .object({
    expected_version: initialVersion,
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
    resource_id: resourceOnlyIdSchema("manage access"),
    policy: validPolicy.optional(),
    email: z.string().email().max(320).optional(),
    id: z.string().min(1).max(64).optional(),
    expected_version: initialVersion
      .optional()
      .describe(
        "Current listed version for configure, resend, revoke_invitation, deny or revoke_grant. Omit on invites and listings; approve uses approval.expected_version.",
      ),
    approval: approval.optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const identity = z.object({ resource_id: resourceOnlyIdSchema("manage access") });
const decision = { id: z.string().regex(/^[a-f0-9]{64}$/), expected_version: version };
const page = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const actions = z
  .discriminatedUnion("action", [
    identity
      .extend({
        action: z.literal("configure"),
        policy: validPolicy,
        expected_version: initialVersion,
      })
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
  ])
  .refine(
    (input) =>
      input.action !== "approve" || input.id === "new" || input.approval.expected_version >= 1,
    "Approval of an existing grant requires expected_version of at least 1",
  )
  .refine(
    (input) =>
      input.action !== "approve" ||
      input.id === "new" ||
      (input.approval.credential_kind === undefined &&
        input.approval.credential_id === undefined &&
        input.approval.credential_public_key_b64 === undefined),
    "Credential fields apply only to id new; use the listed decision id and version for an existing request",
  );
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
      "Manage a private resource's access policy, invitations, access requests, and grants. Invite takes only action, resource_id and email; omit expected_version, approval and policy. Report the exact invited email addresses without shortening them. Check every page of list_invitations before claiming nobody else was invited. If listing is denied, report the send receipts and say the list is unconfirmed; do not resend. Accepted delivery does not prove enrollment. Configure the next policy version, send or resend an email invitation, list invitations or consumer grants, approve or deny a request, approve a credential with id new, or revoke access. Read the current version before a decision; configuring the first policy on an existing private resource uses expected_version 0. For approve, put expected_version inside approval; zero is allowed only for id new. Existing requests use the listed decision id and version without credential fields. A six-digit code alone never authorizes approval on a resource with consumer_access. Ask which listed request the user wants to approve (the verified email for review); keys needs the intended public credential and contract needs a trusted entitlement receipt. Wait for that instruction. After an uncertain invite result, list invitations before retrying. Invite-only access has no consumer requests. Contract approval requires a trusted publisher entitlement receipt and expiry, not an unverified payment claim. A removal is complete only when session_cleanup is complete; retry the same removal/version while pending. Email proves mailbox control, not legal identity. Only listed fields are returned; invitation secrets and bearer links are never returned.",
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
          result.resource = receipt(
            resource,
            (
              await client.updateResource(input.resource_id, {
                consumer_access: input.policy,
                expected_consumer_access_version: input.expected_version,
              })
            ).data,
            input.resource_id,
          );
          if (
            result.resource.consumer_access.mode !== input.policy.mode ||
            result.resource.consumer_access.version !== input.policy.version ||
            result.resource.consumer_access.contract_id !== input.policy.contract_id
          ) {
            throw new QURLAPIError(
              0,
              "access_receipt_unconfirmed",
              "The service did not confirm the private access policy; the update may have been applied. Re-read the resource before retrying.",
            );
          }
          break;
        case "invite":
          result.invitation = receipt(
            invitation,
            await client.inviteConsumer(input.resource_id, input.email),
            input.resource_id,
          );
          break;
        case "resend":
          result.invitation = receipt(
            invitation,
            await client.resendConsumerInvitation(
              input.resource_id,
              input.id,
              input.expected_version,
            ),
            input.resource_id,
          );
          break;
        case "revoke_invitation":
          result.invitation = receipt(
            invitation,
            await client.revokeConsumerInvitation(
              input.resource_id,
              input.id,
              input.expected_version,
            ),
            input.resource_id,
          );
          break;
        case "approve":
          result.grant = receipt(
            grant,
            await client.approveConsumerGrant(input.resource_id, input.id, input.approval),
            input.resource_id,
          );
          break;
        case "deny":
          result.grant = receipt(
            grant,
            await client.denyConsumerGrant(input.resource_id, input.id, input.expected_version),
            input.resource_id,
          );
          break;
        case "revoke_grant":
          result.grant = receipt(
            grant,
            await client.revokeConsumerGrant(input.resource_id, input.id, input.expected_version),
            input.resource_id,
          );
          break;
        case "list_invitations": {
          const reply = await client.listConsumerInvitations(input.resource_id, {
            cursor: input.cursor,
            limit: input.limit,
          });
          result.invitations = receipt(z.array(invitation), reply.invitations, input.resource_id);
          result.next_cursor = reply.next_cursor ?? undefined;
          break;
        }
        case "list_grants": {
          const reply = await client.listConsumerGrants(input.resource_id, {
            cursor: input.cursor,
            limit: input.limit,
          });
          result.grants = receipt(z.array(grant), reply.grants, input.resource_id);
          result.next_cursor = reply.next_cursor ?? undefined;
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

const readAccessActions = z.enum(["list_invitations", "list_grants"]);
const writeAccessActions = z.enum([
  "configure",
  "invite",
  "resend",
  "revoke_invitation",
  "approve",
  "deny",
  "revoke_grant",
]);

// OAuth directory tools separate reads and writes; existing clients keep the combined tool.
export function listCridAccessTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  const tool = manageCridAccessTool(client, runtime);
  const inputSchema = base
    .pick({ resource_id: true, cursor: true, limit: true })
    .extend({ action: readAccessActions });
  return {
    ...tool,
    name: "list_crid_access",
    title: "List private CRID access",
    description:
      "List invitations or consumer grants for one private resource. Follow next_cursor through every page before claiming the list is complete. Returns current versions for access decisions; invitation secrets and bearer links are never returned.",
    inputSchema,
    outputSchema: output
      .pick({ action: true, invitations: true, grants: true, next_cursor: true })
      .extend({ action: readAccessActions }),
    annotations: {
      title: "List private CRID access",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (raw: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      return tool.handler(parsed.data);
    },
  };
}

export function manageCridAccessWriteTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  const tool = manageCridAccessTool(client, runtime);
  const inputSchema = base
    .omit({ cursor: true, limit: true })
    .extend({ action: writeAccessActions });
  return {
    ...tool,
    description:
      "Change private access policy, send or resend invitations, approve or deny requests, approve a credential with id new, or revoke access. Use list_crid_access for invitation and grant listings, and get_qurl for the current policy. Read every listing page before claiming nobody else was invited. Invite takes only action, resource_id and email; report exact invited addresses. If listing is denied, report send receipts and say the list is unconfirmed; do not resend. Accepted delivery does not prove enrollment. After an uncertain invite, list invitations with list_crid_access before retrying. Decisions use the listed id and version. Configure the next policy version; the first policy on an existing private resource uses expected_version 0. For approve, put expected_version inside approval; zero is allowed only for id new. Existing requests use their listed decision id/version without credential fields. A six-digit code alone never authorizes approval. Ask which listed request the user wants to approve (verified email for review); keys needs the intended public credential and contract needs a trusted entitlement receipt and expiry. Wait for that instruction. This tool does not verify payment. Invite-only access has no consumer requests. Removal is complete only when session_cleanup is complete; retry the same removal/version while pending. Email proves mailbox control, not legal identity. Invitation secrets and bearer links are never returned.",
    inputSchema,
    outputSchema: output
      .omit({ invitations: true, grants: true, next_cursor: true })
      .extend({ action: writeAccessActions }),
    handler: async (raw: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      return tool.handler(parsed.data);
    },
  };
}
