import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database, TicketStatus } from "../database/types.js";
import { staffTicketMutationFields } from "./staff-ticket.fields.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function statusTransitionQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  source: TicketStatus,
  target: TicketStatus,
) {
  return (
    executor
      .updateTable("tickets")
      .set({
        status: target,
        closed_at: target === "CLOSED" ? sql<Date>`clock_timestamp()` : null,
        updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
      })
      .where("organization_id", "=", organizationId)
      .where("id", "=", ticketId)
      .where("voided_at", "is", null)
      // Compare against the exact source validated by the service, not any valid source.
      .where("status", "=", source)
      .returning(staffTicketMutationFields)
      .$narrowType<{ customerName: string }>()
  );
}

export async function attemptAdminStatusTransition(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  source: TicketStatus,
  target: TicketStatus,
) {
  return statusTransitionQuery(
    executor,
    organizationId,
    ticketId,
    source,
    target,
  ).executeTakeFirst();
}

export async function attemptAgentStatusTransition(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  source: TicketStatus,
  target: TicketStatus,
  agent: { id: string; teamId: string | null },
) {
  return statusTransitionQuery(
    executor,
    organizationId,
    ticketId,
    source,
    target,
  )
    .where((eb) =>
      eb.or([
        eb("assigned_agent_id", "=", agent.id),
        eb.and([
          eb("assigned_agent_id", "is", null),
          // SQL equality with NULL deliberately does not authorize an unassigned ticket.
          eb("assigned_team_id", "=", agent.teamId),
        ]),
      ]),
    )
    .executeTakeFirst();
}
