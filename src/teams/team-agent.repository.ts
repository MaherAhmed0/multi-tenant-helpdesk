import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function moveActiveTeamAgents(
  executor: DatabaseExecutor,
  organizationId: string,
  sourceTeamId: string,
  targetTeamId: string,
): Promise<void> {
  await executor
    .updateTable("users")
    .set({ team_id: targetTeamId, updated_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("team_id", "=", sourceTeamId)
    .where("role", "=", "AGENT")
    .where("deactivated_at", "is", null)
    .execute();
}
