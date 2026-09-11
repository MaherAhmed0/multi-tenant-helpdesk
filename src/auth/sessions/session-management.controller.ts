import type { Request, Response } from "express";
import { z } from "zod";

import {
  listSessions,
  revokeOwnedSession,
  logoutAll,
} from "./session-management.service.js";
import {
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "./session-cookie.js";

const sessionIdSchema = z.uuid().transform((id) => id.toLowerCase());

export async function listSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  const sessions = await listSessions(req.auth);

  res.status(200).json({ sessions });
}

export async function revokeSessionController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  const result = sessionIdSchema.safeParse(req.params.sessionId);

  if (result.success) {
    await revokeOwnedSession(req.auth, result.data);

    if (result.data === req.auth.sessionId) {
      res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());
    }
  }

  res.status(204).send();
}

export async function logoutAllController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  await logoutAll(req.auth);

  res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions());

  res.status(204).send();
}
