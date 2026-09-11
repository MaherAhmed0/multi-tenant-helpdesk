import { verify } from "otplib";

import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import { hashAuthChallengeToken } from "../challenge/auth-challenge-token.js";
import {
  consumeAuthChallenge,
  findActiveAuthChallenge,
  recordAuthChallengeFailure,
} from "../challenge/auth-challenge.repository.js";
import {
  claimSystemAdminTotpTimeStep,
  findSystemAdminForTotp,
} from "../system-admin.repository.js";
import { decryptTotpSecret } from "../totp-secret-crypto.js";
import { TOTP_OPTIONS } from "../totp.config.js";
import { generateSystemAdminSessionToken } from "../sessions/session-token.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "../sessions/session.constants.js";
import { createSystemAdminSession } from "../sessions/session.repository.js";

function mfaFailure(): AppError {
  return new AppError(401, "MFA authentication failed");
}

export async function completeSystemAdminMfa(input: {
  challengeToken: string;
  code: string;
  userAgent: string | null;
}) {
  const challenge = await findActiveAuthChallenge(
    db,
    hashAuthChallengeToken(input.challengeToken),
  );
  if (!challenge) throw mfaFailure();

  const admin = await findSystemAdminForTotp(db, challenge.systemAdminId);
  if (!admin || admin.deactivatedAt !== null) throw mfaFailure();

  const verification = await verify({
    ...TOTP_OPTIONS,
    secret: decryptTotpSecret(admin),
    token: input.code,
  });
  if (!verification.valid) {
    await recordAuthChallengeFailure(db, challenge.id);
    throw mfaFailure();
  }
  // otplib's functional API also supports HOTP; this flow requires its TOTP result.
  if (!("timeStep" in verification)) {
    throw new Error("TOTP verification did not return an accepted time step");
  }

  const { token, tokenHash } = generateSystemAdminSessionToken();
  const absoluteExpiresAt = new Date(
    Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
  );

  await db.transaction().execute(async (trx) => {
    // Lock order: administrator, then challenge. All success state commits together.
    const claimed = await claimSystemAdminTotpTimeStep(
      trx,
      admin.id,
      verification.timeStep,
    );
    if (!claimed) throw mfaFailure();

    const consumed = await consumeAuthChallenge(trx, challenge.id);
    if (!consumed) throw mfaFailure();

    await createSystemAdminSession(trx, {
      systemAdminId: admin.id,
      tokenHash,
      absoluteExpiresAt,
      userAgent: input.userAgent,
    });
  });

  return { token };
}
