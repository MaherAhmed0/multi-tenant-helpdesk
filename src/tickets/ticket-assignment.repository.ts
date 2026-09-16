import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import { staffTicketMutationFields } from "./staff-ticket.fields.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function attemptReleaseTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  ticketId: string,
) {
  return (
    executor
      .updateTable("tickets")
      .set({
        assigned_agent_id: null,
        updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
      })
      .where("organization_id", "=", organizationId)
      .where("id", "=", ticketId)
      .where("voided_at", "is", null)
      .where("status", "in", ["OPEN", "IN_PROGRESS"])
      .where("assigned_agent_id", "=", agentId)
      .returning(staffTicketMutationFields)
      // The required tenant-qualified customer FK guarantees a customer name.
      .$narrowType<{ customerName: string }>()
      .executeTakeFirst()
  );
}

export async function replaceTicketAssignment(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  assignment: { teamId: string | null; agentId: string | null },
) {
  return executor
    .updateTable("tickets")
    .set({
      assigned_team_id: assignment.teamId,
      assigned_agent_id: assignment.agentId,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .where("status", "in", ["OPEN", "IN_PROGRESS"])
    .returning(staffTicketMutationFields)
    .$narrowType<{ customerName: string }>()
    .executeTakeFirst();
}

export async function attemptClaimTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  ticketId: string,
) {
  // Lock the claimant before modifying a ticket, coordinating with user lifecycle
  // UPDATEs and their ticket cleanup. No separate transaction or ticket FOR UPDATE.
  return (
    executor
      .with(
        (cte) => cte("claimant").materialized(),
        (db) =>
          db
            .selectFrom("users")
            .select(["id", "name", "team_id"])
            .where("organization_id", "=", organizationId)
            .where("id", "=", agentId)
            .where("role", "=", "AGENT")
            .where("deactivated_at", "is", null)
            .forShare(),
      )
      .updateTable("tickets")
      .from("claimant")
      .set({
        assigned_agent_id: agentId,
        updated_at: sql<Date>`greatest(tickets.updated_at, clock_timestamp())`,
      })
      .where("tickets.organization_id", "=", organizationId)
      .where("tickets.id", "=", ticketId)
      .where("tickets.voided_at", "is", null)
      .where("tickets.assigned_agent_id", "is", null)
      .where("tickets.status", "in", ["OPEN", "IN_PROGRESS"])
      .where((eb) =>
        eb.or([
          eb("tickets.assigned_team_id", "is", null),
          eb("tickets.assigned_team_id", "=", eb.ref("claimant.team_id")),
        ]),
      )
      .returning([
        "tickets.id",
        "tickets.subject",
        "tickets.status",
        "tickets.priority",
        "tickets.created_at as createdAt",
        "tickets.updated_at as updatedAt",
        "tickets.closed_at as closedAt",
        "tickets.assigned_team_id as assignedTeamId",
        "tickets.assigned_agent_id as assignedAgentId",
        "claimant.name as assignedAgentName",
      ])
      .returning((eb) => [
        eb
          .selectFrom("users as customer")
          .select("customer.name")
          .whereRef("customer.organization_id", "=", "tickets.organization_id")
          .whereRef("customer.id", "=", "tickets.customer_id")
          .as("customerName"),
        eb
          .selectFrom("teams as assigned_team")
          .select("assigned_team.name")
          .whereRef(
            "assigned_team.organization_id",
            "=",
            "tickets.organization_id",
          )
          .whereRef("assigned_team.id", "=", "tickets.assigned_team_id")
          .as("assignedTeamName"),
      ])
      // The required tenant-qualified customer FK guarantees this row exists.
      .$narrowType<{ customerName: string }>()
      .executeTakeFirst()
  );
}

export async function clearAgentTicketAssignments(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
): Promise<void> {
  await executor
    .updateTable("tickets")
    .set({
      assigned_agent_id: null,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("assigned_agent_id", "=", agentId)
    .execute();
}

export async function clearIncompatibleAgentTicketAssignments(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  newTeamId: string,
): Promise<void> {
  await executor
    .updateTable("tickets")
    .set({
      assigned_agent_id: null,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("assigned_agent_id", "=", agentId)
    .where("assigned_team_id", "is not", null)
    .where("assigned_team_id", "!=", newTeamId)
    .execute();
}

export async function clearTeamTicketAssignments(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
): Promise<void> {
  await executor
    .updateTable("tickets")
    .set((eb) => ({
      assigned_team_id: null,
      assigned_agent_id: eb
        .case()
        .when(
          eb.exists(
            eb
              .selectFrom("users as agent")
              .select("agent.id")
              .whereRef("agent.organization_id", "=", "tickets.organization_id")
              .whereRef("agent.id", "=", "tickets.assigned_agent_id")
              .where("agent.role", "=", "AGENT")
              .where("agent.deactivated_at", "is", null),
          ),
        )
        .then(eb.ref("tickets.assigned_agent_id"))
        .else(null)
        .end(),
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    }))
    .where("organization_id", "=", organizationId)
    .where("assigned_team_id", "=", teamId)
    .execute();
}
