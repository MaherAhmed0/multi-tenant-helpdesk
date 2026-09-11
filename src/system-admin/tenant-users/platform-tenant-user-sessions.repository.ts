import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function revokePlatformTenantUserSessions(
  executor: DatabaseExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  // Tenant sessions only; preserve both ownership predicates and prior revocations.
  await executor
    .updateTable("sessions")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}
