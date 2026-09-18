import { sql, type Kysely, type Transaction } from "kysely";

import type { Database, TicketStatus } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const activeStatuses: TicketStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED"];

export async function aggregateWorkloadAssignment(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("tickets")
    .where("organization_id", "=", organizationId)
    .where("voided_at", "is", null)
    .where("status", "in", activeStatuses)
    .select((eb) => [
      sql<Date>`statement_timestamp()`.as("generatedAt"),
      eb.fn
        .countAll<string>()
        .filterWhere("assigned_team_id", "is", null)
        .filterWhere("assigned_agent_id", "is", null)
        .as("fullyUnassigned"),
      eb.fn
        .countAll<string>()
        .filterWhere("assigned_team_id", "is not", null)
        .filterWhere("assigned_agent_id", "is", null)
        .as("teamOnly"),
      eb.fn
        .countAll<string>()
        .filterWhere("assigned_team_id", "is", null)
        .filterWhere("assigned_agent_id", "is not", null)
        .as("agentOnly"),
      eb.fn
        .countAll<string>()
        .filterWhere("assigned_team_id", "is not", null)
        .filterWhere("assigned_agent_id", "is not", null)
        .as("teamAndAgent"),
    ])
    .executeTakeFirstOrThrow();
}

export async function aggregateTeamWorkload(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return (
    executor
      .selectFrom("teams")
      // Ticket filters belong in ON so active teams with zero tickets remain visible.
      .leftJoin("tickets", (join) =>
        join
          .onRef("tickets.assigned_team_id", "=", "teams.id")
          .onRef("tickets.organization_id", "=", "teams.organization_id")
          .on("tickets.organization_id", "=", organizationId)
          .on("tickets.voided_at", "is", null)
          .on("tickets.status", "in", activeStatuses),
      )
      .where("teams.organization_id", "=", organizationId)
      .where("teams.deactivated_at", "is", null)
      .select(["teams.id as teamId", "teams.name as teamName"])
      .select((eb) => [
        eb.fn.count<string>("tickets.id").as("activeTickets"),
        eb.fn
          .count<string>("tickets.id")
          .filterWhere("tickets.assigned_agent_id", "is", null)
          .as("teamOnlyTickets"),
        eb.fn
          .count<string>("tickets.id")
          .filterWhere("tickets.assigned_agent_id", "is not", null)
          .as("teamAndAgentTickets"),
      ])
      .groupBy(["teams.id", "teams.name"])
      .orderBy("teams.name", "asc")
      .orderBy("teams.id", "asc")
      .execute()
  );
}

export async function aggregateAgentWorkload(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("users")
    .leftJoin("tickets", (join) =>
      join
        .onRef("tickets.assigned_agent_id", "=", "users.id")
        .onRef("tickets.organization_id", "=", "users.organization_id")
        .on("tickets.organization_id", "=", organizationId)
        .on("tickets.voided_at", "is", null)
        .on("tickets.status", "in", activeStatuses),
    )
    .where("users.organization_id", "=", organizationId)
    .where("users.role", "=", "AGENT")
    .where("users.deactivated_at", "is", null)
    .select(["users.id as agentId", "users.name as agentName"])
    .select((eb) =>
      eb.fn.count<string>("tickets.id").as("activeAssignedTickets"),
    )
    .groupBy(["users.id", "users.name"])
    .orderBy("users.name", "asc")
    .orderBy("users.id", "asc")
    .execute();
}
