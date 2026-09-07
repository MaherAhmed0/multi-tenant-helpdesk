import argon2 from "argon2";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_OBSERVATION_WINDOW_MS,
  LOGIN_BLOCK_DURATION_MS,
} from "./auth.constants.js";
import { hashLoginIdentifier } from "./login-throttle-key.js";
import {
  findActiveLoginBlock,
  recordLoginFailure,
  clearLoginThrottle,
} from "./login-throttle.repository.js";
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
  const identifierHash = hashLoginIdentifier(input.organizationSlug, input.email);

  if (await findActiveLoginBlock(db, identifierHash)) {
    throw new AppError(429, "Too many login attempts");
  }

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
    const throttle = await recordLoginFailure(db, {
      identifierHash,
      observationWindowMs: LOGIN_OBSERVATION_WINDOW_MS,
      blockDurationMs: LOGIN_BLOCK_DURATION_MS,
      failureThreshold: LOGIN_FAILURE_THRESHOLD,
    });

    if (throttle.failed_attempts >= LOGIN_FAILURE_THRESHOLD) {
      throw new AppError(429, "Too many login attempts");
    }

    throw new AppError(401, "Invalid credentials");
  }

  await clearLoginThrottle(db, identifierHash);

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
