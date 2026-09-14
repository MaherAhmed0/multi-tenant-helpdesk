import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";
import { invitationState } from "../agent-invitations/invitation.repository.js";
import type { InvitationListInput } from "../agent-invitations/invitation.repository.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function adminInvitationQuery(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .selectFrom("tenant_user_invitations")
    .where("organization_id", "=", organizationId)
    .where("role", "=", "ORGANIZATION_ADMIN")
    .select([
      "id", "name", "email", "created_at as createdAt", "expires_at as expiresAt",
      "revoked_at as revokedAt", "consumed_at as consumedAt",
    ])
    .select(invitationState.as("state"));
}

export async function listAdminInvitations(
  executor: DatabaseExecutor,
  organizationId: string,
  input: InvitationListInput,
) {
  let query = adminInvitationQuery(executor, organizationId);
  if (input.status) query = query.where(invitationState, "=", input.status);
  const count = await query.clearSelect()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const invitations = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)
    .execute();
  return { invitations, total: Number(count.total) };
}

export async function findAdminInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return adminInvitationQuery(executor, organizationId)
    .where("id", "=", invitationId)
    .executeTakeFirstOrThrow();
}

export async function findAdminInvitationForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return adminInvitationQuery(executor, organizationId)
    .where("id", "=", invitationId)
    .forUpdate()
    .executeTakeFirst();
}

export async function revokeOpenAdminInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return executor
    .updateTable("tenant_user_invitations")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("role", "=", "ORGANIZATION_ADMIN")
    .where("id", "=", invitationId)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .returning("id")
    .executeTakeFirstOrThrow();
}

export async function insertAdminInvitation(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    name: string;
    email: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  },
) {
  return executor
    .insertInto("tenant_user_invitations")
    .values({
      organization_id: input.organizationId,
      role: "ORGANIZATION_ADMIN",
      target_team_id: null,
      name: input.name,
      email: input.email,
      token_hash: input.tokenHash,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      revoked_at: null,
      consumed_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
