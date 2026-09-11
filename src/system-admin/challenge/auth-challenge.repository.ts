import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../../database/types.js";
import { AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS } from "./auth-challenge.constants.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateAuthChallengeInput {
  systemAdminId: string;
  tokenHash: string;
  expiresAt: Date;
}

// A challenge records password-step success, never authenticated session state.
export async function createAuthChallenge(
  executor: DatabaseExecutor,
  input: CreateAuthChallengeInput,
) {
  return executor
    .insertInto("system_admin_auth_challenges")
    .values({
      system_admin_id: input.systemAdminId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
    })
    .returning([
      "id",
      "system_admin_id as systemAdminId",
      "failed_attempts as failedAttempts",
      "expires_at as expiresAt",
      "consumed_at as consumedAt",
      "created_at as createdAt",
    ])
    .executeTakeFirstOrThrow();
}

export async function findActiveAuthChallenge(
  executor: DatabaseExecutor,
  tokenHash: string,
) {
  return executor
    .selectFrom("system_admin_auth_challenges")
    .select([
      "id",
      "system_admin_id as systemAdminId",
      "failed_attempts as failedAttempts",
      "expires_at as expiresAt",
      "consumed_at as consumedAt",
      "created_at as createdAt",
    ])
    .where("token_hash", "=", tokenHash)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .where("failed_attempts", "<", AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS)
    .executeTakeFirst();
}

export async function recordAuthChallengeFailure(
  executor: DatabaseExecutor,
  challengeId: string,
) {
  // PostgreSQL locks the row and rechecks these predicates after concurrent updates.
  return executor
    .updateTable("system_admin_auth_challenges")
    .set((eb) => ({ failed_attempts: eb("failed_attempts", "+", 1) }))
    .where("id", "=", challengeId)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .where("failed_attempts", "<", AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS)
    .returning(["id", "failed_attempts as failedAttempts"])
    .executeTakeFirst();
}

export async function consumeAuthChallenge(
  executor: DatabaseExecutor,
  challengeId: string,
) {
  // Conditional UPDATE gives a single winner; a prior lookup is not authorization.
  return executor
    .updateTable("system_admin_auth_challenges")
    .set({ consumed_at: sql<Date>`clock_timestamp()` })
    .where("id", "=", challengeId)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .where("failed_attempts", "<", AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS)
    .returning([
      "id",
      "system_admin_id as systemAdminId",
      "consumed_at as consumedAt",
    ])
    .executeTakeFirst();
}
