import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  AUTH_CHALLENGE_COOKIE_NAME,
  getAuthChallengeCookieOptions,
} from "./auth-challenge-cookie.js";
import {
  SYSTEM_ADMIN_SESSION_COOKIE_NAME,
  getSystemAdminSessionCookieOptions,
} from "./session-cookie.js";
import { recoverySchema } from "./recovery.schema.js";
import { completeSystemAdminRecovery } from "./recovery.service.js";

export async function systemAdminRecoveryController(
  req: Request,
  res: Response,
): Promise<void> {
  const result = recoverySchema.safeParse(req.body);
  if (!result.success) {
    throw new AppError(400, "Invalid MFA data", result.error.issues);
  }
  const challengeToken = req.cookies?.[AUTH_CHALLENGE_COOKIE_NAME];
  if (typeof challengeToken !== "string" || challengeToken.length === 0) {
    throw new AppError(401, "MFA authentication failed");
  }

  const session = await completeSystemAdminRecovery({
    challengeToken,
    code: result.data.code,
    userAgent: req.get("user-agent") ?? null,
  });

  res.clearCookie(AUTH_CHALLENGE_COOKIE_NAME, getAuthChallengeCookieOptions());
  res.cookie(
    SYSTEM_ADMIN_SESSION_COOKIE_NAME,
    session.token,
    getSystemAdminSessionCookieOptions(),
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json({ authenticated: true });
}
