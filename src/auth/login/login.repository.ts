import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";

interface FindLoginAccountInput {
  organizationSlug: string;
  email: string;
}

export async function findLoginAccount(
  db: Kysely<Database>,
  input: FindLoginAccountInput,
) {
  return db
    .selectFrom("organizations")
    .innerJoin("users", "users.organization_id", "organizations.id")
    .select([
      "users.id as userId",
      "users.organization_id as organizationId",
      "users.name as name",
      "users.email as email",
      "users.password_hash as passwordHash",
      "users.role as role",
      "users.deactivated_at as userDeactivatedAt",
      "organizations.slug as organizationSlug",
      "organizations.deactivated_at as organizationDeactivatedAt",
    ])
    .where("organizations.slug", "=", input.organizationSlug)
    .where("users.email", "=", input.email)
    .executeTakeFirst();
}
