import type { NextFunction, Request, Response } from "express";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  SYSTEM_ADMIN_SESSION_COOKIE_NAME,
  getSystemAdminSessionCookieOptions,
} from "./sessions/session-cookie.js";
import { hashSystemAdminSessionToken } from "./sessions/session-token.js";
import {
  findActiveSystemAdminSession,
  updateSystemAdminSessionActivity,
} from "./sessions/session.repository.js";

export interface SystemAdminAuthContext {
  systemAdminId: string;
  sessionId: string;
  email: string;
}

export async function requireSystemAdminAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token: unknown = req.cookies?.[SYSTEM_ADMIN_SESSION_COOKIE_NAME];
  const session =
    typeof token === "string" && token.length > 0
      ? await findActiveSystemAdminSession(
          db,
          hashSystemAdminSessionToken(token),
        )
      : undefined;

  // The lookup alone is insufficient: refresh rechecks validity in the database.
  const refreshed = session
    ? await updateSystemAdminSessionActivity(db, session.sessionId)
    : undefined;

  if (!session || !refreshed) {
    if (token !== undefined) {
      res.clearCookie(
        SYSTEM_ADMIN_SESSION_COOKIE_NAME,
        getSystemAdminSessionCookieOptions(),
      );
    }
    throw new AppError(401, "Authentication required");
  }

  req.systemAdminAuth = {
    systemAdminId: session.systemAdminId,
    sessionId: session.sessionId,
    email: session.email,
  };
  next();
}
