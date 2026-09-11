import argon2 from "argon2";
import { DatabaseError } from "pg";

import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import { provisioningSchema } from "./provisioning.schema.js";
import type { ProvisioningInput } from "./provisioning.schema.js";
import { generateRecoveryCodes } from "../recovery-codes.js";
import { createRecoveryCodeHashes } from "../recovery-code.repository.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import { encryptTotpSecret } from "../totp-secret-crypto.js";

export async function provisionSystemAdmin(input: ProvisioningInput) {
  const result = provisioningSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, "Invalid system administrator provisioning data");
  }

  const passwordHash = await argon2.hash(result.data.password, {
    type: argon2.argon2id,
  });
  const encryptedTotp = encryptTotpSecret(result.data.confirmedTotpSecret);
  const recoveryCodes = generateRecoveryCodes();
  const codeHashes = recoveryCodes.map(({ hash }) => hash);

  try {
    const systemAdmin = await db.transaction().execute(async (trx) => {
      const admin = await createSystemAdmin(trx, {
        email: result.data.email,
        passwordHash,
        totpSecretCiphertext: encryptedTotp.ciphertext,
        totpSecretIv: encryptedTotp.iv,
        totpSecretAuthTag: encryptedTotp.authTag,
      });

      await createRecoveryCodeHashes(trx, admin.id, codeHashes);

      return admin;
    });

    // execute() resolves after commit; raw codes never cross the repository boundary.
    return {
      systemAdmin,
      recoveryCodes: recoveryCodes.map(({ code }) => code),
    };
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === "23505" &&
      error.constraint === "system_admins_email_unique"
    ) {
      throw new AppError(409, "System administrator email already exists");
    }

    throw error;
  }
}
