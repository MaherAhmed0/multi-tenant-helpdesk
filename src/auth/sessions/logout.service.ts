import { db } from "../../database/db.js";
import { logger } from "../../observability/logger.js";
import { revokeSession } from "./session.repository.js";

export async function logout(sessionId: string): Promise<void> {
  if (await revokeSession(db, sessionId, new Date())) {
    logger.info({
      event: "session_revoked",
      scope: "tenant_session",
      targetSessionId: sessionId,
    });
  }
}
