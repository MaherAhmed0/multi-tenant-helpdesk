import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export async function createOrganization(
  executor: DatabaseExecutor,
  input: CreateOrganizationInput,
) {
  return executor
    .insertInto("organizations")
    .values({
      name: input.name,
      slug: input.slug,
    })
    .returning(["id", "name", "slug"])
    .executeTakeFirstOrThrow();
}
