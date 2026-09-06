import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { loginSchema } from "./login.schema.js";
import { login } from "./login.service.js";
import { getSessionCookieOptions, SESSION_COOKIE_NAME } from "./session-cookie.js";

export async function loginController(
  req: Request,
  res: Response,
): Promise<void> {
  const result = loginSchema.safeParse(req.body);

  if (!result.success) {
    throw new AppError(400, "Invalid login data", result.error.issues);
  }

  const loginResult = await login(result.data, {
    userAgent: req.get("user-agent") ?? null,
  });

  res.cookie(SESSION_COOKIE_NAME, loginResult.token, getSessionCookieOptions());

  res.status(200).json({
    user: loginResult.user,
    session: loginResult.session,
  });
}
