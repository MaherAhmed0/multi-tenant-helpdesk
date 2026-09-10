import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";
import { SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS } from "./session.constants.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateSystemAdminSessionInput {
  systemAdminId: string;
  tokenHash: string;
  absoluteExpiresAt: Date;
  userAgent: string | null;
}

// The caller must complete authentication before creating a privileged session.
export async function createSystemAdminSession(
  executor: DatabaseExecutor,
  input: CreateSystemAdminSessionInput,
) {
  return executor
    .insertInto("system_admin_sessions")
    .values({
      system_admin_id: input.systemAdminId,
      token_hash: input.tokenHash,
      absolute_expires_at: input.absoluteExpiresAt,
      user_agent: input.userAgent,
    })
    .returning([
      "id",
      "system_admin_id as systemAdminId",
      "created_at as createdAt",
      "last_activity_at as lastActivityAt",
      "absolute_expires_at as absoluteExpiresAt",
      "revoked_at as revokedAt",
      "user_agent as userAgent",
    ])
    .executeTakeFirstOrThrow();
}

export async function findActiveSystemAdminSession(
  executor: DatabaseExecutor,
  tokenHash: string,
) {
  return executor
    .selectFrom("system_admin_sessions")
    .innerJoin(
      "system_admins",
      "system_admins.id",
      "system_admin_sessions.system_admin_id",
    )
    .select([
      "system_admin_sessions.id as sessionId",
      "system_admins.id as systemAdminId",
      "system_admins.email as email",
      "system_admin_sessions.last_activity_at as lastActivityAt",
      "system_admin_sessions.absolute_expires_at as absoluteExpiresAt",
    ])
    .where("system_admin_sessions.token_hash", "=", tokenHash)
    .where("system_admin_sessions.revoked_at", "is", null)
    .where(
      "system_admin_sessions.absolute_expires_at",
      ">",
      sql<Date>`clock_timestamp()`,
    )
    .where(
      "system_admin_sessions.last_activity_at",
      ">",
      sql<Date>`
      clock_timestamp() - ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS} * interval '1 millisecond'
    `,
    )
    .where("system_admins.deactivated_at", "is", null)
    .executeTakeFirst();
}

export async function updateSystemAdminSessionActivity(
  executor: DatabaseExecutor,
  sessionId: string,
) {
  // Use database time; row locking and GREATEST prevent backwards activity updates.
  // Recheck validity so a lookup followed by a delayed update cannot revive expiry.
  return executor
    .updateTable("system_admin_sessions")
    .from("system_admins")
    .set({
      last_activity_at: sql<Date>`greatest(system_admin_sessions.last_activity_at, clock_timestamp())`,
    })
    .whereRef("system_admins.id", "=", "system_admin_sessions.system_admin_id")
    .where("system_admin_sessions.id", "=", sessionId)
    .where("system_admin_sessions.revoked_at", "is", null)
    .where(
      "system_admin_sessions.absolute_expires_at",
      ">",
      sql<Date>`clock_timestamp()`,
    )
    .where(
      "system_admin_sessions.last_activity_at",
      ">",
      sql<Date>`
      clock_timestamp() - ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS} * interval '1 millisecond'
    `,
    )
    .where("system_admins.deactivated_at", "is", null)
    .returning([
      "system_admin_sessions.id as sessionId",
      "system_admin_sessions.last_activity_at as lastActivityAt",
    ])
    .executeTakeFirst();
}

export async function revokeSystemAdminSession(
  executor: DatabaseExecutor,
  sessionId: string,
) {
  return executor
    .updateTable("system_admin_sessions")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .returning(["id", "revoked_at as revokedAt"])
    .executeTakeFirst();
}

export async function findUsableSystemAdminSessions(
  executor: DatabaseExecutor,
  systemAdminId: string,
) {
  return executor
    .selectFrom("system_admin_sessions")
    .innerJoin(
      "system_admins",
      "system_admins.id",
      "system_admin_sessions.system_admin_id",
    )
    .select([
      "system_admin_sessions.id as id",
      "system_admin_sessions.created_at as createdAt",
      "system_admin_sessions.last_activity_at as lastActivityAt",
      "system_admin_sessions.absolute_expires_at as absoluteExpiresAt",
      "system_admin_sessions.user_agent as userAgent",
    ])
    .where("system_admin_sessions.system_admin_id", "=", systemAdminId)
    .where("system_admin_sessions.revoked_at", "is", null)
    .where(
      "system_admin_sessions.absolute_expires_at",
      ">",
      sql<Date>`clock_timestamp()`,
    )
    .where(
      "system_admin_sessions.last_activity_at",
      ">",
      sql<Date>`
      clock_timestamp() - ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS} * interval '1 millisecond'
    `,
    )
    .where("system_admins.deactivated_at", "is", null)
    .orderBy("system_admin_sessions.created_at", "desc")
    .orderBy("system_admin_sessions.id", "desc")
    .execute();
}

export async function revokeOwnedSystemAdminSession(
  executor: DatabaseExecutor,
  input: { systemAdminId: string; sessionId: string },
): Promise<void> {
  await executor
    .updateTable("system_admin_sessions")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("id", "=", input.sessionId)
    .where("system_admin_id", "=", input.systemAdminId)
    .where("revoked_at", "is", null)
    .execute();
}

export async function revokeSystemAdminSessions(
  executor: DatabaseExecutor,
  systemAdminId: string,
): Promise<void> {
  await executor
    .updateTable("system_admin_sessions")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("system_admin_id", "=", systemAdminId)
    .where("revoked_at", "is", null)
    .execute();
}
