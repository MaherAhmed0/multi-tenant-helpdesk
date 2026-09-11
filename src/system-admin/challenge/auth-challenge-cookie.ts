import type { CookieOptions } from "express";

import { env } from "../../config/env.js";

export const AUTH_CHALLENGE_COOKIE_NAME = "system_admin_mfa_challenge";

export function getAuthChallengeCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: env.sessionCookieSecure,
    path: "/system-admin/auth",
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}
