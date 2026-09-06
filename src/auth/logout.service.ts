import { db } from "../database/db.js";
import { revokeSession } from "./session.repository.js";

export async function logout(sessionId: string): Promise<void> {
  await revokeSession(db, sessionId, new Date());
}
