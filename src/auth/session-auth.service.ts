import { db } from "../database/db.js";
import { SESSION_IDLE_TIMEOUT_MS } from "./auth.constants.js";
import {
  findSessionForAuthentication,
  updateSessionActivity,
} from "./session.repository.js";
import { hashSessionToken } from "./session-token.js";

export interface AuthContext {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: "ORGANIZATION_ADMIN" | "AGENT" | "CUSTOMER";
}

export async function authenticateSession(
  token: string,
): Promise<AuthContext | null> {
  const tokenHash = hashSessionToken(token);

  const session = await findSessionForAuthentication(db, tokenHash);

  if (!session) {
    return null;
  }

  const now = new Date();

  if (
    session.revokedAt !== null ||
    session.userDeactivatedAt !== null ||
    session.organizationDeactivatedAt !== null ||
    session.absoluteExpiresAt <= now
  ) {
    return null;
  }

  const idleExpiresAt =
    session.lastActivityAt.getTime() + SESSION_IDLE_TIMEOUT_MS;

  if (idleExpiresAt <= now.getTime()) {
    return null;
  }

  await updateSessionActivity(db, session.sessionId, now);

  return {
    sessionId: session.sessionId,
    userId: session.userId,
    organizationId: session.organizationId,
    role: session.role,
  };
}
