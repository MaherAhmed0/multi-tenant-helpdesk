import type { NextFunction, Request, Response } from "express";

import { AppError } from "../errors/app-error.js";

export function requireOrganizationAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    throw new AppError(401, "Authentication required");
  }
  if (req.auth.role !== "ORGANIZATION_ADMIN") {
    throw new AppError(403, "Request forbidden");
  }
  next();
}
