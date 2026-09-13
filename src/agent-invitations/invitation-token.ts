import { createHash, randomBytes } from "node:crypto";

export const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInvitationToken() {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);
  return { token, tokenHash };
}
