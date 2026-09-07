import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";

export function deriveCsrfToken(sessionId: string): string {
  return createHmac("sha256", env.csrfSecret).update(sessionId).digest("hex");
}

export function isValidCsrfToken(sessionId: string, token: string): boolean {
  const expected = Buffer.from(deriveCsrfToken(sessionId), "utf8");
  const submitted = Buffer.from(token, "utf8");

  return (
    submitted.length === expected.length && timingSafeEqual(submitted, expected)
  );
}
