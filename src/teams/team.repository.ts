import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function createGeneralTeam(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .insertInto("teams")
    .values({
      organization_id: organizationId,
      name: "General",
      is_general: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
