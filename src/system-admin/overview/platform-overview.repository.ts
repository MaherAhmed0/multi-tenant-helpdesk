import type { Kysely, Transaction } from "kysely";

import type { Database } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Platform-wide aggregates, deliberately separate from tenant-scoped repositories.
export async function countPlatformOverview(executor: DatabaseExecutor) {
  return executor
    .with("organization_counts", (db) =>
      db
        .selectFrom("organizations")
        .select((eb) => [
          eb.fn.countAll<string>().as("organizationTotal"),
          eb.fn
            .countAll<string>()
            .filterWhere("deactivated_at", "is", null)
            .as("organizationActive"),
          eb.fn
            .countAll<string>()
            .filterWhere("deactivated_at", "is not", null)
            .as("organizationDeactivated"),
        ]),
    )
    .with("user_counts", (db) =>
      db.selectFrom("users").select((eb) => [
        eb.fn.countAll<string>().as("userTotal"),
        // Account state, independent of whether the parent organization is active.
        eb.fn
          .countAll<string>()
          .filterWhere("deactivated_at", "is", null)
          .as("userActive"),
        eb.fn
          .countAll<string>()
          .filterWhere("deactivated_at", "is not", null)
          .as("userDeactivated"),
        eb.fn
          .countAll<string>()
          .filterWhere("role", "=", "ORGANIZATION_ADMIN")
          .as("organizationAdmins"),
        eb.fn.countAll<string>().filterWhere("role", "=", "AGENT").as("agents"),
        eb.fn
          .countAll<string>()
          .filterWhere("role", "=", "CUSTOMER")
          .as("customers"),
      ]),
    )
    .selectFrom("organization_counts")
    .crossJoin("user_counts")
    .selectAll()
    .executeTakeFirstOrThrow();
}
