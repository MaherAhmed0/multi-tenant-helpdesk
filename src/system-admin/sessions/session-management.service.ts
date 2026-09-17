import { db } from "../../database/db.js";
import { logger } from "../../observability/logger.js";
import type { SystemAdminAuthContext } from "../auth.middleware.js";
import {
  findUsableSystemAdminSessions,
  revokeOwnedSystemAdminSession,
  revokeSystemAdminSessions,
} from "./session.repository.js";

export async function listSystemAdminSessions(auth: SystemAdminAuthContext) {
  const sessions = await findUsableSystemAdminSessions(db, auth.systemAdminId);
  return sessions.map((session) => ({
    ...session,
    isCurrent: session.id === auth.sessionId,
  }));
}

export async function revokeOwnedSession(
  auth: SystemAdminAuthContext,
  sessionId: string,
): Promise<void> {
  const revoked = await revokeOwnedSystemAdminSession(db, {
    systemAdminId: auth.systemAdminId,
    sessionId,
  });
  if (revoked) logger.info({ event: "session_revoked", scope: "system_admin_session", targetSessionId: sessionId });
}

export async function logoutSystemAdmin(
  auth: SystemAdminAuthContext,
): Promise<void> {
  await revokeOwnedSession(auth, auth.sessionId);
}

export async function logoutAllSystemAdminSessions(
  auth: SystemAdminAuthContext,
): Promise<void> {
  await revokeSystemAdminSessions(db, auth.systemAdminId);
  logger.info({ event: "sessions_revoked", scope: "system_admin_account" });
}
