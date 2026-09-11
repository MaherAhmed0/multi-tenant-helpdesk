import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Privileged organization-wide revocation of tenant sessions only.
// sessions_user_tenant_fk ensures each session's user belongs to this organization.
export async function revokePlatformOrganizationSessions(
  executor: DatabaseExecutor,
  organizationId: string,
): Promise<void> {
  await executor
    .updateTable("sessions")
    .set({ revoked_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("revoked_at", "is", null)
    .execute();
}
