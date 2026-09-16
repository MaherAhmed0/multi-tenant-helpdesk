import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function replyTicketQuery(executor: DatabaseExecutor, organizationId: string, ticketId: string) {
  return executor.selectFrom("tickets")
    .select(["id", "status"])
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null);
}

export async function findOrganizationTicketForReplyUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return replyTicketQuery(executor, organizationId, ticketId)
    .forUpdate().executeTakeFirst();
}

export async function findAgentTicketForReplyUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  agent: { id: string; teamId: string | null },
) {
  return replyTicketQuery(executor, organizationId, ticketId)
    .where((eb) => eb.or([
      eb("assigned_agent_id", "=", agent.id),
      eb.and([
        eb("assigned_agent_id", "is", null),
        eb("assigned_team_id", "=", agent.teamId),
      ]),
    ]))
    .forUpdate().executeTakeFirst();
}

// The service holds the authorized ticket lock through message insertion and touch.
export async function touchStaffReplyTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return executor.updateTable("tickets")
    .set({ updated_at: sql<Date>`greatest(updated_at, clock_timestamp())` })
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .where("status", "in", ["OPEN", "IN_PROGRESS", "RESOLVED"])
    .returning("status")
    .executeTakeFirstOrThrow();
}
