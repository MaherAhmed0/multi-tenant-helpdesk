import { sql, type Kysely, type Transaction } from "kysely";

import type { Database, TicketVoidReason } from "../database/types.js";
import { staffTicketMutationFields } from "./staff-ticket.fields.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
export type StaffVoidReason = Exclude<TicketVoidReason, "CUSTOMER_WITHDRAWN">;

function voidTicketQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  actorId: string,
  reason: TicketVoidReason,
) {
  return executor
    .updateTable("tickets")
    .set({
      voided_at: sql<Date>`clock_timestamp()`,
      voided_by_user_id: actorId,
      void_reason: reason,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .returning("id");
}

export async function attemptCustomerWithdrawTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  ticketId: string,
) {
  return voidTicketQuery(
    executor,
    organizationId,
    ticketId,
    customerId,
    "CUSTOMER_WITHDRAWN",
  )
    .where("customer_id", "=", customerId)
    .where("status", "in", ["OPEN", "IN_PROGRESS", "RESOLVED"])
    .executeTakeFirst();
}

export async function attemptAdminVoidTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  adminId: string,
  reason: StaffVoidReason,
) {
  return voidTicketQuery(
    executor,
    organizationId,
    ticketId,
    adminId,
    reason,
  ).executeTakeFirst();
}

export async function attemptAgentVoidTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  agent: { id: string; teamId: string | null },
  reason: StaffVoidReason,
) {
  return voidTicketQuery(executor, organizationId, ticketId, agent.id, reason)
    .where((eb) =>
      eb.or([
        eb("assigned_agent_id", "=", agent.id),
        eb.and([
          eb("assigned_agent_id", "is", null),
          // SQL equality with NULL cannot authorize a fully unassigned ticket.
          eb("assigned_team_id", "=", agent.teamId),
        ]),
      ]),
    )
    .executeTakeFirst();
}

export async function attemptRestoreTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  // Dedicated restoration predicate; normal reads still exclude voided tickets.
  return executor
    .updateTable("tickets")
    .set({
      voided_at: null,
      voided_by_user_id: null,
      void_reason: null,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is not", null)
    .returning(staffTicketMutationFields)
    .$narrowType<{ customerName: string }>()
    .executeTakeFirst();
}
