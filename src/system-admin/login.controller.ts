import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  AUTH_CHALLENGE_COOKIE_NAME,
  getAuthChallengeCookieOptions,
} from "./auth-challenge-cookie.js";
import { systemAdminLoginSchema } from "./login.schema.js";
import { startSystemAdminLogin } from "./login.service.js";

export async function systemAdminLoginController(
  req: Request,
  res: Response,
): Promise<void> {
  const result = systemAdminLoginSchema.safeParse(req.body);
  if (!result.success) {
    throw new AppError(400, "Invalid login data", result.error.issues);
  }

  const challenge = await startSystemAdminLogin(result.data);
  res.cookie(
    AUTH_CHALLENGE_COOKIE_NAME,
    challenge.token,
    getAuthChallengeCookieOptions(challenge.expiresAt),
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json({ mfaRequired: true });
}
