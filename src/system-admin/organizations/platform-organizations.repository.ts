import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../../database/types.js";
import type { OrganizationListInput } from "./organizations.schema.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function deactivatePlatformOrganization(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .updateTable("organizations")
    .set({
      deactivated_at: sql<Date>`coalesce(deactivated_at, clock_timestamp())`,
      updated_at: sql<Date>`case when deactivated_at is null then clock_timestamp() else updated_at end`,
    })
    .where("id", "=", organizationId)
    .returning("id")
    .executeTakeFirst();
}

export async function reactivatePlatformOrganization(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .updateTable("organizations")
    .set({
      deactivated_at: null,
      updated_at: sql<Date>`case when deactivated_at is not null then clock_timestamp() else updated_at end`,
    })
    .where("id", "=", organizationId)
    .returning("id")
    .executeTakeFirst();
}

// Explicit cross-tenant reads for authenticated SYSTEM_ADMIN platform administration.
export async function listPlatformOrganizations(
  executor: DatabaseExecutor,
  input: OrganizationListInput,
) {
  let query = executor.selectFrom("organizations");
  if (input.status) {
    query = query.where(
      "deactivated_at",
      input.status === "active" ? "is" : "is not",
      null,
    );
  }
  if (input.search) {
    // Treat user-supplied LIKE wildcards as literal characters.
    const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
    query = query.where((eb) =>
      eb.or([eb("name", "ilike", pattern), eb("slug", "ilike", pattern)]),
    );
  }

  const count = await query
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const organizations = await query
    .select([
      "id",
      "name",
      "slug",
      "deactivated_at as deactivatedAt",
      "created_at as createdAt",
      "updated_at as updatedAt",
    ])
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)
    .execute();

  return { organizations, total: Number(count.total) };
}

export async function findPlatformOrganization(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("organizations")
    .select([
      "id",
      "name",
      "slug",
      "deactivated_at as deactivatedAt",
      "created_at as createdAt",
      "updated_at as updatedAt",
    ])
    .where("id", "=", organizationId)
    .executeTakeFirst();
}

export async function findPlatformOrganizationAdmins(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("users")
    .select([
      "id",
      "name",
      "email",
      "deactivated_at as deactivatedAt",
      "created_at as createdAt",
    ])
    .where("organization_id", "=", organizationId)
    .where("role", "=", "ORGANIZATION_ADMIN")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
}
