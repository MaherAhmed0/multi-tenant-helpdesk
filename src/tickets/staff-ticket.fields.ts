import type { ExpressionBuilder } from "kysely";

import type { Database } from "../database/types.js";

// Safe staff fields from the actual mutation result, without a later visibility read.
export function staffTicketMutationFields(eb: ExpressionBuilder<Database, "tickets">) {
  return [
    "tickets.id",
    "tickets.subject",
    "tickets.status",
    "tickets.priority",
    "tickets.created_at as createdAt",
    "tickets.updated_at as updatedAt",
    "tickets.closed_at as closedAt",
    "tickets.assigned_team_id as assignedTeamId",
    "tickets.assigned_agent_id as assignedAgentId",
    eb.selectFrom("users as customer").select("customer.name")
      .whereRef("customer.organization_id", "=", "tickets.organization_id")
      .whereRef("customer.id", "=", "tickets.customer_id").as("customerName"),
    eb.selectFrom("teams as assigned_team").select("assigned_team.name")
      .whereRef("assigned_team.organization_id", "=", "tickets.organization_id")
      .whereRef("assigned_team.id", "=", "tickets.assigned_team_id").as("assignedTeamName"),
    eb.selectFrom("users as assigned_agent").select("assigned_agent.name")
      .whereRef("assigned_agent.organization_id", "=", "tickets.organization_id")
      .whereRef("assigned_agent.id", "=", "tickets.assigned_agent_id").as("assignedAgentName"),
  ] as const;
}
