import type { NextFunction, Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { authenticateSession } from "./session-auth.service.js";

export async function requireAuthentication(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies.session;

  if (typeof token !== "string" || token.length === 0) {
    throw new AppError(401, "Authentication required");
  }

  const auth = await authenticateSession(token);

  if (!auth) {
    throw new AppError(401, "Authentication required");
  }

  req.auth = auth;

  next();
}
