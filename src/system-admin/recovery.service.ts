import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { hashAuthChallengeToken } from "./auth-challenge-token.js";
import {
  consumeAuthChallenge,
  findActiveAuthChallenge,
  recordAuthChallengeFailure,
} from "./auth-challenge.repository.js";
import { hashRecoveryCode } from "./recovery-codes.js";
import { consumeRecoveryCode } from "./recovery-code.repository.js";
import { lockActiveSystemAdminForRecovery } from "./system-admin.repository.js";
import { generateSystemAdminSessionToken } from "./session-token.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "./session.constants.js";
import { createSystemAdminSession } from "./session.repository.js";

function mfaFailure(): AppError {
  return new AppError(401, "MFA authentication failed");
}

export async function completeSystemAdminRecovery(input: {
  challengeToken: string;
  code: string;
  userAgent: string | null;
}) {
  const challenge = await findActiveAuthChallenge(
    db,
    hashAuthChallengeToken(input.challengeToken),
  );
  if (!challenge) throw mfaFailure();

  const codeHash = hashRecoveryCode(input.code);
  const { token, tokenHash } = generateSystemAdminSessionToken();
  const absoluteExpiresAt = new Date(
    Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
  );
  const invalidCode = mfaFailure();

  try {
    await db.transaction().execute(async (trx) => {
      // Lock order: administrator, recovery code, challenge. No crypto under locks.
      const admin = await lockActiveSystemAdminForRecovery(
        trx,
        challenge.systemAdminId,
      );
      if (!admin) throw mfaFailure();

      const recoveryCode = await consumeRecoveryCode(trx, admin.id, codeHash);
      if (!recoveryCode) throw invalidCode;

      const consumed = await consumeAuthChallenge(trx, challenge.id);
      if (!consumed) throw mfaFailure();

      await createSystemAdminSession(trx, {
        systemAdminId: admin.id,
        tokenHash,
        absoluteExpiresAt,
        userAgent: input.userAgent,
      });
    });
  } catch (error) {
    // Count credential rejection after rollback; unexpected DB failures propagate.
    if (error === invalidCode) {
      await recordAuthChallengeFailure(db, challenge.id);
    }
    throw error;
  }

  return { token };
}
