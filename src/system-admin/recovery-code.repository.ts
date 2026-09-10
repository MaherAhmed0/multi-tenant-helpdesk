import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function consumeRecoveryCode(
  executor: DatabaseExecutor,
  systemAdminId: string,
  codeHash: string,
) {
  return executor
    .updateTable("system_admin_recovery_codes")
    .set({ used_at: sql<Date>`clock_timestamp()` })
    .where("system_admin_id", "=", systemAdminId)
    .where("code_hash", "=", codeHash)
    .where("used_at", "is", null)
    .returning("id")
    .executeTakeFirst();
}

export async function createRecoveryCodeHashes(
  executor: DatabaseExecutor,
  systemAdminId: string,
  codeHashes: readonly string[],
): Promise<void> {
  await executor
    .insertInto("system_admin_recovery_codes")
    .values(
      codeHashes.map((codeHash) => ({
        system_admin_id: systemAdminId,
        code_hash: codeHash,
      })),
    )
    .execute();
}
