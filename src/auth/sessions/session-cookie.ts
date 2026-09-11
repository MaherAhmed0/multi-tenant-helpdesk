import type { CookieOptions } from "express";

import { env } from "../../config/env.js";

export const SESSION_COOKIE_NAME = "session";

export function getSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: env.sessionCookieSecure,
    path: "/",
  };
}
