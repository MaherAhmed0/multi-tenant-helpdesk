import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Slug-based discovery is limited to these explicitly public onboarding operations.
export async function findPublicActiveOrganizationBySlug(
  executor: DatabaseExecutor,
  slug: string,
) {
  return executor
    .selectFrom("organizations")
    .select(["name", "slug"])
    .where("slug", "=", slug)
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
}

export async function findRegistrationOrganizationForShare(
  executor: DatabaseExecutor,
  slug: string,
) {
  return executor
    .selectFrom("organizations")
    .select(["id", "deactivated_at as deactivatedAt"])
    .where("slug", "=", slug)
    // Conflicts with organization deactivation's UPDATE, unlike FOR KEY SHARE.
    .forShare()
    .executeTakeFirst();
}
