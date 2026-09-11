import { createHash, randomBytes } from "node:crypto";

const SESSION_TOKEN_BYTES = 32;

export function hashSystemAdminSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSystemAdminSessionToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashSystemAdminSessionToken(token) };
}
