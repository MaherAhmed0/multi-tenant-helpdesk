import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateSessionInput {
  organizationId: string;
  userId: string;
  tokenHash: string;
  absoluteExpiresAt: Date;
  userAgent: string | null;
}

export async function createSession(
  executor: DatabaseExecutor,
  input: CreateSessionInput,
) {
  return executor
    .insertInto("sessions")
    .values({
      organization_id: input.organizationId,
      user_id: input.userId,
      token_hash: input.tokenHash,
      absolute_expires_at: input.absoluteExpiresAt,
      user_agent: input.userAgent,
    })
    .returning([
      "id",
      "organization_id",
      "user_id",
      "created_at",
      "last_activity_at",
      "absolute_expires_at",
      "revoked_at",
      "user_agent",
    ])
    .executeTakeFirstOrThrow();
}

export async function findSessionForAuthentication(
  executor: DatabaseExecutor,
  tokenHash: string,
) {
  return executor
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .innerJoin("organizations", "organizations.id", "sessions.organization_id")
    .select([
      "sessions.id as sessionId",
      "sessions.organization_id as organizationId",
      "sessions.user_id as userId",
      "sessions.last_activity_at as lastActivityAt",
      "sessions.absolute_expires_at as absoluteExpiresAt",
      "sessions.revoked_at as revokedAt",

      "users.role as role",
      "users.deactivated_at as userDeactivatedAt",

      "organizations.deactivated_at as organizationDeactivatedAt",
    ])
    .where("sessions.token_hash", "=", tokenHash)
    .executeTakeFirst();
}

export async function updateSessionActivity(
  executor: DatabaseExecutor,
  sessionId: string,
  activityAt: Date,
): Promise<void> {
  await executor
    .updateTable("sessions")
    .set({
      last_activity_at: activityAt,
    })
    .where("id", "=", sessionId)
    .execute();
}

export async function revokeSession(
  executor: DatabaseExecutor,
  sessionId: string,
  revokedAt: Date,
): Promise<void> {
  await executor
    .updateTable("sessions")
    .set({
      revoked_at: revokedAt,
    })
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .execute();
}
