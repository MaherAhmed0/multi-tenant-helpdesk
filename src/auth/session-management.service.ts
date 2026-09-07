import { db } from "../database/db.js";
import { SESSION_IDLE_TIMEOUT_MS } from "./auth.constants.js";
import type { AuthContext } from "./session-auth.service.js";
import {
  findUsableAccountSessions,
  revokeAccountSession,
  revokeAccountSessions,
} from "./session.repository.js";

export async function listSessions(auth: AuthContext) {
  const now = new Date();
  const sessions = await findUsableAccountSessions(db, {
    userId: auth.userId,
    organizationId: auth.organizationId,
    now,
    idleCutoff: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS),
  });

  return sessions.map((session) => ({
    ...session,
    isCurrent: session.id === auth.sessionId,
  }));
}

export async function revokeOwnedSession(
  auth: AuthContext,
  sessionId: string,
): Promise<void> {
  await revokeAccountSession(db, {
    userId: auth.userId,
    organizationId: auth.organizationId,
    sessionId,
    revokedAt: new Date(),
  });
}

export async function logoutAll(auth: AuthContext): Promise<void> {
  await revokeAccountSessions(db, {
    userId: auth.userId,
    organizationId: auth.organizationId,
    revokedAt: new Date(),
  });
}
