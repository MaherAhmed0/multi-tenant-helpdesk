import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Public credential lookup: the stored invitation, never request identity fields,
// establishes organization scope for every subsequent operation.
export async function findInvitationByTokenHash(
  executor: DatabaseExecutor,
  tokenHash: string,
) {
  return executor
    .selectFrom("tenant_user_invitations")
    .select("id")
    .where("token_hash", "=", tokenHash)
    .where("role", "in", ["AGENT", "ORGANIZATION_ADMIN"])
    .executeTakeFirst();
}

export async function findInvitationForAcceptance(
  executor: DatabaseExecutor,
  tokenHash: string,
) {
  const invitation = await executor
    .selectFrom("tenant_user_invitations")
    .select([
      "id",
      "organization_id as organizationId",
      "name",
      "email",
      "role",
      "target_team_id as targetTeamId",
      "expires_at as expiresAt",
      "consumed_at as consumedAt",
      "revoked_at as revokedAt",
    ])
    .where("token_hash", "=", tokenHash)
    .where("role", "in", ["AGENT", "ORGANIZATION_ADMIN"])
    .forUpdate()
    .executeTakeFirst();
  if (!invitation) return undefined;

  // Read database time after acquiring the lock, including any time spent waiting.
  const { now } = await executor
    .selectNoFrom(sql<Date>`clock_timestamp()`.as("now"))
    .executeTakeFirstOrThrow();
  return { ...invitation, isExpired: invitation.expiresAt <= now };
}

export async function findAcceptanceOrganizationForShare(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return (
    executor
      .selectFrom("organizations")
      .select(["id", "deactivated_at as deactivatedAt"])
      .where("id", "=", organizationId)
      // FOR SHARE conflicts with deactivation's non-key UPDATE; KEY SHARE would not.
      .forShare()
      .executeTakeFirst()
  );
}

export async function consumeInvitation(
  executor: DatabaseExecutor,
  organizationId: string,
  invitationId: string,
) {
  return executor
    .updateTable("tenant_user_invitations")
    .set({ consumed_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("id", "=", invitationId)
    .where("role", "in", ["AGENT", "ORGANIZATION_ADMIN"])
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .returning("id")
    .executeTakeFirst();
}
