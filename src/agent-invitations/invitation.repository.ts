import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
type InvitationState = "pending" | "expired" | "revoked" | "consumed";

export interface InvitationListInput {
  status?: InvitationState | undefined;
  page: number;
  limit: number;
}

export const invitationState = sql<InvitationState>`case
  when tenant_user_invitations.consumed_at is not null then 'consumed'
  when tenant_user_invitations.revoked_at is not null then 'revoked'
  when tenant_user_invitations.expires_at <= statement_timestamp() then 'expired'
  else 'pending' end`;

function invitationQuery(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .selectFrom("tenant_user_invitations")
    .leftJoin("teams", (join) =>
      join
        .onRef("teams.id", "=", "tenant_user_invitations.target_team_id")
        .onRef(
          "teams.organization_id",
          "=",
          "tenant_user_invitations.organization_id",
        ),
    )
    .where("tenant_user_invitations.organization_id", "=", organizationId)
    .where("tenant_user_invitations.role", "=", "AGENT")
    .select([
      "tenant_user_invitations.id",
      "tenant_user_invitations.name",
      "tenant_user_invitations.email",
      "tenant_user_invitations.created_at as createdAt",
      "tenant_user_invitations.expires_at as expiresAt",
      "tenant_user_invitations.revoked_at as revokedAt",
      "tenant_user_invitations.consumed_at as consumedAt",
      "teams.id as targetTeamId",
      "teams.name as targetTeamName",
      "teams.is_general as targetTeamIsGeneral",
      "teams.deactivated_at as targetTeamDeactivatedAt",
    ])
    .select(invitationState.as("state"));
}

export async function listInvitations(
  executor: DatabaseExecutor,
  organizationId: string,
  input: InvitationListInput,
) {
  let query = invitationQuery(executor, organizationId);
  if (input.status) query = query.where(invitationState, "=", input.status);
  const count = await query
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const invitations = await query
    .orderBy("tenant_user_invitations.created_at", "desc")
    .orderBy("tenant_user_invitations.id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)
    .execute();
  return { invitations, total: Number(count.total) };
}

export async function findInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return invitationQuery(executor, organizationId)
    .where("tenant_user_invitations.id", "=", invitationId)
    .executeTakeFirstOrThrow();
}

export async function findExistingUser(
  executor: DatabaseExecutor,
  organizationId: string,
  email: string,
) {
  return executor
    .selectFrom("users")
    .select("id")
    .where("organization_id", "=", organizationId)
    .where("email", "=", email)
    .executeTakeFirst();
}

export async function findOpenInvitationForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  email: string,
) {
  // Creation collisions follow the shared organization/email index, across roles.
  return executor
    .selectFrom("tenant_user_invitations")
    .select("id")
    .select(sql<boolean>`expires_at <= clock_timestamp()`.as("isExpired"))
    .where("organization_id", "=", organizationId)
    .where("email", "=", email)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
}

// Internal replacement only; public AGENT revocation remains role-scoped below.
export async function closeExpiredOpenInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return executor
    .updateTable("tenant_user_invitations")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("id", "=", invitationId)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
    .returning("id")
    .executeTakeFirstOrThrow();
}

export async function findInvitationForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return executor
    .selectFrom("tenant_user_invitations")
    .select(["id", "consumed_at as consumedAt", "revoked_at as revokedAt"])
    .where("organization_id", "=", organizationId)
    .where("role", "=", "AGENT")
    .where("id", "=", invitationId)
    .forUpdate()
    .executeTakeFirst();
}

export async function revokeOpenInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return executor
    .updateTable("tenant_user_invitations")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("role", "=", "AGENT")
    .where("id", "=", invitationId)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .returning("id")
    .executeTakeFirstOrThrow();
}

export async function insertInvitation(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    name: string;
    email: string;
    targetTeamId: string | null;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  },
) {
  return executor
    .insertInto("tenant_user_invitations")
    .values({
      organization_id: input.organizationId,
      role: "AGENT",
      name: input.name,
      email: input.email,
      target_team_id: input.targetTeamId,
      token_hash: input.tokenHash,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      consumed_at: null,
      revoked_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
