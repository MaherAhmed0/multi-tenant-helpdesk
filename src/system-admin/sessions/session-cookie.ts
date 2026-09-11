import type { CookieOptions } from "express";

import { env } from "../../config/env.js";

export const SYSTEM_ADMIN_SESSION_COOKIE_NAME = "system_admin_session";

export function getSystemAdminSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: env.sessionCookieSecure,
    path: "/system-admin",
  };
}
