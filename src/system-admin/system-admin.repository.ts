import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateSystemAdminInput {
  email: string;
  passwordHash: string;
  totpSecretCiphertext: string;
  totpSecretIv: string;
  totpSecretAuthTag: string;
}

export async function createSystemAdmin(
  executor: DatabaseExecutor,
  input: CreateSystemAdminInput,
) {
  return executor
    .insertInto("system_admins")
    .values({
      email: input.email,
      password_hash: input.passwordHash,
      totp_secret_ciphertext: input.totpSecretCiphertext,
      totp_secret_iv: input.totpSecretIv,
      totp_secret_auth_tag: input.totpSecretAuthTag,
      last_totp_time_step: null,
    })
    .returning(["id", "email", "created_at as createdAt"])
    .executeTakeFirstOrThrow();
}
