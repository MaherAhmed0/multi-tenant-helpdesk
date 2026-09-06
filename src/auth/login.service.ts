import argon2 from "argon2";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "./auth.constants.js";
import { findLoginAccount } from "./login.repository.js";
import { createSession } from "./session.repository.js";
import { generateSessionToken, hashSessionToken } from "./session-token.js";

import type { LoginInput } from "./login.schema.js";

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$u70fNb9bs9DpgNz9KU5yEg$uG3768+9jHsK01Su8RJf2+qCf/Sbq0YirpqlO3QfCXA";

interface LoginContext {
  userAgent: string | null;
}

export async function login(input: LoginInput, context: LoginContext) {
  const account = await findLoginAccount(db, {
    organizationSlug: input.organizationSlug,
    email: input.email,
  });

  const passwordHash = account?.passwordHash ?? DUMMY_PASSWORD_HASH;

  const passwordMatches = await argon2.verify(passwordHash, input.password);

  if (
    !account ||
    !passwordMatches ||
    account.userDeactivatedAt !== null ||
    account.organizationDeactivatedAt !== null
  ) {
    throw new AppError(401, "Invalid credentials");
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);

  const absoluteExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS);

  const session = await createSession(db, {
    organizationId: account.organizationId,
    userId: account.userId,
    tokenHash,
    absoluteExpiresAt,
    userAgent: context.userAgent,
  });

  return {
    token,
    session: {
      id: session.id,
      absoluteExpiresAt: session.absolute_expires_at,
    },
    user: {
      id: account.userId,
      organizationId: account.organizationId,
      name: account.name,
      email: account.email,
      role: account.role,
    },
  };
}
