import type { Request, Response } from "express";
import { z } from "zod";

import {
  listSystemAdminSessions,
  revokeOwnedSession,
  logoutSystemAdmin,
  logoutAllSystemAdminSessions,
} from "./session-management.service.js";
import {
  SYSTEM_ADMIN_SESSION_COOKIE_NAME,
  getSystemAdminSessionCookieOptions,
} from "./session-cookie.js";

const sessionIdSchema = z.uuid().transform((id) => id.toLowerCase());

export async function logoutSystemAdminController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth) {
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  }
  await logoutSystemAdmin(req.systemAdminAuth);
  res.clearCookie(
    SYSTEM_ADMIN_SESSION_COOKIE_NAME,
    getSystemAdminSessionCookieOptions(),
  );
  res.status(204).send();
}

export async function listSystemAdminSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth) {
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  }
  const sessions = await listSystemAdminSessions(req.systemAdminAuth);
  res.set("Cache-Control", "no-store");
  res.status(200).json({ sessions });
}

export async function revokeSystemAdminSessionController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth) {
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  }
  const result = sessionIdSchema.safeParse(req.params.id);
  if (result.success) {
    await revokeOwnedSession(req.systemAdminAuth, result.data);
    if (result.data === req.systemAdminAuth.sessionId) {
      res.clearCookie(
        SYSTEM_ADMIN_SESSION_COOKIE_NAME,
        getSystemAdminSessionCookieOptions(),
      );
    }
  }
  res.status(204).send();
}

export async function logoutAllSystemAdminSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth) {
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  }
  await logoutAllSystemAdminSessions(req.systemAdminAuth);
  res.clearCookie(
    SYSTEM_ADMIN_SESSION_COOKIE_NAME,
    getSystemAdminSessionCookieOptions(),
  );
  res.status(204).send();
}
