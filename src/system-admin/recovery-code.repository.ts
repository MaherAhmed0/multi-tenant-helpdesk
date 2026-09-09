import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

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
