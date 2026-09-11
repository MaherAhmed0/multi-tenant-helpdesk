import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

import type { Database } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Explicit platform access: userId selects a resource, never tenant auth context.
export async function findPlatformTenantUser(
  executor: DatabaseExecutor,
  userId: string,
) {
  return executor
    .selectFrom("users")
    .select([
      "id",
      "organization_id as organizationId",
      "role",
      "deactivated_at as deactivatedAt",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
}

export async function lockOrganizationForAdminDeactivation(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("organizations")
    .select(["id", "deactivated_at as deactivatedAt"])
    .where("id", "=", organizationId)
    .forUpdate()
    .executeTakeFirst();
}

export async function lockOrganizationForUserReactivation(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  // Shared locks allow concurrent reactivations but exclude organization updates
  // and the exclusive coordination lock used by admin deactivation.
  return executor
    .selectFrom("organizations")
    .select(["id", "deactivated_at as deactivatedAt"])
    .where("id", "=", organizationId)
    .forShare()
    .executeTakeFirst();
}

export async function findOtherActiveOrganizationAdmin(
  executor: DatabaseExecutor,
  organizationId: string,
  userId: string,
) {
  return executor
    .selectFrom("users")
    .select("id")
    .where("organization_id", "=", organizationId)
    .where("role", "=", "ORGANIZATION_ADMIN")
    .where("deactivated_at", "is", null)
    .where("id", "!=", userId)
    .limit(1)
    .executeTakeFirst();
}

export async function deactivatePlatformTenantUser(
  executor: DatabaseExecutor,
  organizationId: string,
  userId: string,
) {
  return executor
    .updateTable("users")
    .set({
      deactivated_at: sql<Date>`coalesce(deactivated_at, clock_timestamp())`,
      updated_at: sql<Date>`case when deactivated_at is null then clock_timestamp() else updated_at end`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();
}

export async function reactivatePlatformTenantUser(
  executor: DatabaseExecutor,
  organizationId: string,
  userId: string,
) {
  return executor
    .updateTable("users")
    .set({
      deactivated_at: null,
      updated_at: sql<Date>`case when deactivated_at is not null then clock_timestamp() else updated_at end`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();
}
