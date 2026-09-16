import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database, TicketPriority } from "../database/types.js";
import { staffTicketMutationFields } from "./staff-ticket.fields.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function priorityUpdateQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  priority: TicketPriority,
) {
  return executor
    .updateTable("tickets")
    .set({
      priority,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .where("status", "in", ["OPEN", "IN_PROGRESS", "RESOLVED"])
    // Exclude non-changes without comparing against a previously read priority.
    .where("priority", "!=", priority)
    .returning(staffTicketMutationFields)
    .$narrowType<{ customerName: string }>();
}

export async function attemptAdminPriorityUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  priority: TicketPriority,
) {
  return priorityUpdateQuery(executor, organizationId, ticketId, priority)
    .executeTakeFirst();
}

export async function attemptAgentPriorityUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  priority: TicketPriority,
  agent: { id: string; teamId: string | null },
) {
  return priorityUpdateQuery(executor, organizationId, ticketId, priority)
    .where((eb) => eb.or([
      eb("assigned_agent_id", "=", agent.id),
      eb.and([
        eb("assigned_agent_id", "is", null),
        // Equality with NULL does not authorize a fully unassigned ticket.
        eb("assigned_team_id", "=", agent.teamId),
      ]),
    ]))
    .executeTakeFirst();
}
