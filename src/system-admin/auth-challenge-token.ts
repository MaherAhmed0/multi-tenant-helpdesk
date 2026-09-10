import { createHash, randomBytes } from "node:crypto";

const AUTH_CHALLENGE_TOKEN_BYTES = 32;

export function hashAuthChallengeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAuthChallengeToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomBytes(AUTH_CHALLENGE_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashAuthChallengeToken(token) };
}
