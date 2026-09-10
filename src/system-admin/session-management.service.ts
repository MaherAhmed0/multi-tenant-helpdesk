import { db } from "../database/db.js";
import type { SystemAdminAuthContext } from "./auth.middleware.js";
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
  await revokeOwnedSystemAdminSession(db, {
    systemAdminId: auth.systemAdminId,
    sessionId,
  });
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
}
