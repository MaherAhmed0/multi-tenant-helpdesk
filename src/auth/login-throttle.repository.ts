import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function findActiveLoginBlock(
  executor: DatabaseExecutor,
  identifierHash: string,
) {
  return executor
    .selectFrom("login_throttles")
    .select("blocked_until")
    .where("identifier_hash", "=", identifierHash)
    .where("blocked_until", ">", sql<Date>`statement_timestamp()`)
    .executeTakeFirst();
}

interface RecordLoginFailureInput {
  identifierHash: string;
  observationWindowMs: number;
  blockDurationMs: number;
  failureThreshold: number;
}

export async function recordLoginFailure(
  executor: DatabaseExecutor,
  input: RecordLoginFailureInput,
) {
  // Keep time monotonic if statements acquire the conflicting row out of order.
  const attemptTime = sql<Date>`greatest(excluded.updated_at, login_throttles.updated_at)`;
  const windowExpired = sql<boolean>`
    login_throttles.window_started_at <=
      ${attemptTime} - ${input.observationWindowMs} * interval '1 millisecond'
  `;
  const failureCount = sql<number>`
    case when ${windowExpired} then 1
    else login_throttles.failed_attempts + 1 end
  `;

  return executor
    .insertInto("login_throttles")
    .values({
      identifier_hash: input.identifierHash,
      failed_attempts: 1,
      window_started_at: sql<Date>`statement_timestamp()`,
      blocked_until: null,
      updated_at: sql<Date>`statement_timestamp()`,
    })
    .onConflict((conflict) =>
      conflict.column("identifier_hash").doUpdateSet({
        failed_attempts: failureCount,
        window_started_at: sql<Date>`
        case when ${windowExpired} then ${attemptTime}
        else login_throttles.window_started_at end
      `,
        blocked_until: sql<Date | null>`
        case when ${failureCount} >= ${input.failureThreshold}
        then ${attemptTime} + ${input.blockDurationMs} * interval '1 millisecond'
        else null end
      `,
        updated_at: attemptTime,
      }),
    )
    .returning("failed_attempts")
    .executeTakeFirstOrThrow();
}

export async function clearLoginThrottle(
  executor: DatabaseExecutor,
  identifierHash: string,
): Promise<void> {
  await executor
    .deleteFrom("login_throttles")
    .where("identifier_hash", "=", identifierHash)
    .execute();
}
