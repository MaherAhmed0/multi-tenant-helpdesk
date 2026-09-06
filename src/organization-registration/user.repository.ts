import type { Kysely, Transaction } from "kysely";

import type { Database, TenantRole } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateUserInput {
  organizationId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: TenantRole;
}

export async function createUser(
  executor: DatabaseExecutor,
  input: CreateUserInput,
) {
  return executor
    .insertInto("users")
    .values({
      organization_id: input.organizationId,
      name: input.name,
      email: input.email,
      password_hash: input.passwordHash,
      role: input.role,
    })
    .returning(["id", "organization_id", "name", "email", "role"])
    .executeTakeFirstOrThrow();
}
