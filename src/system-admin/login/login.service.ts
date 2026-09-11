import argon2 from "argon2";

import { db } from "../../database/db.js";
import { AppError } from "../../errors/app-error.js";
import { AUTH_CHALLENGE_LIFETIME_MS } from "../challenge/auth-challenge.constants.js";
import { generateAuthChallengeToken } from "../challenge/auth-challenge-token.js";
import { createAuthChallenge } from "../challenge/auth-challenge.repository.js";
import { findSystemAdminForPasswordLogin } from "../system-admin.repository.js";
import type { SystemAdminLoginInput } from "./login.schema.js";

// Same fixed dummy Argon2id hash used by tenant login; no account credential.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$u70fNb9bs9DpgNz9KU5yEg$uG3768+9jHsK01Su8RJf2+qCf/Sbq0YirpqlO3QfCXA";

export async function startSystemAdminLogin(input: SystemAdminLoginInput) {
  const account = await findSystemAdminForPasswordLogin(db, input.email);
  const activeAccount = account?.deactivatedAt === null ? account : undefined;
  const passwordMatches = await argon2.verify(
    activeAccount?.passwordHash ?? DUMMY_PASSWORD_HASH,
    input.password,
  );

  if (!activeAccount || !passwordMatches) {
    throw new AppError(401, "Invalid credentials");
  }

  // Password-step success creates only a pending challenge, never a session.
  const { token, tokenHash } = generateAuthChallengeToken();
  const challenge = await createAuthChallenge(db, {
    systemAdminId: activeAccount.id,
    tokenHash,
    expiresAt: new Date(Date.now() + AUTH_CHALLENGE_LIFETIME_MS),
  });

  return { token, expiresAt: challenge.expiresAt };
}
