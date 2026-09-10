import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

// Call inside the recovery transaction to serialize completion with deactivation.
export async function lockActiveSystemAdminForRecovery(
  executor: DatabaseExecutor,
  systemAdminId: string,
) {
  return executor
    .selectFrom("system_admins")
    .select("id")
    .where("id", "=", systemAdminId)
    .where("deactivated_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
}

export async function findSystemAdminForTotp(
  executor: DatabaseExecutor,
  systemAdminId: string,
) {
  return executor
    .selectFrom("system_admins")
    .select([
      "id",
      "totp_secret_ciphertext as ciphertext",
      "totp_secret_iv as iv",
      "totp_secret_auth_tag as authTag",
      "deactivated_at as deactivatedAt",
    ])
    .where("id", "=", systemAdminId)
    .executeTakeFirst();
}

export async function claimSystemAdminTotpTimeStep(
  executor: DatabaseExecutor,
  systemAdminId: string,
  acceptedTimeStep: number,
) {
  return executor
    .updateTable("system_admins")
    .set({
      last_totp_time_step: acceptedTimeStep,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where("id", "=", systemAdminId)
    .where("deactivated_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("last_totp_time_step", "is", null),
        eb("last_totp_time_step", "<", acceptedTimeStep),
      ]),
    )
    .returning("id")
    .executeTakeFirst();
}

export async function findSystemAdminForPasswordLogin(
  executor: DatabaseExecutor,
  email: string,
) {
  return executor
    .selectFrom("system_admins")
    .select([
      "id",
      "password_hash as passwordHash",
      "deactivated_at as deactivatedAt",
    ])
    .where("email", "=", email)
    .executeTakeFirst();
}

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
