import type { NextFunction, Request, Response } from "express";

import { AppError } from "../../errors/app-error.js";
import { isValidCsrfToken } from "./csrf-token.js";

export function requireCsrfToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  const token = req.get("X-CSRF-Token");

  if (!token || !isValidCsrfToken(req.auth.sessionId, token)) {
    throw new AppError(403, "Invalid CSRF token");
  }

  next();
}

export function requireLoginClient(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // Cross-origin browser requests need a successful CORS preflight to set this.
  if (req.get("X-Helpdesk-Client") !== "web") {
    throw new AppError(403, "Request forbidden");
  }

  next();
}
