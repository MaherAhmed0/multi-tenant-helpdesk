import type { Request, Response } from "express";

import { logout } from "./logout.service.js";
import {
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "./session-cookie.js";

export async function logoutController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  await logout(req.auth.sessionId);

  res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());

  res.status(204).send();
}
