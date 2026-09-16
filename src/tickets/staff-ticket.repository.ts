import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function staffTicketQuery(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .selectFrom("tickets")
    .innerJoin("users as customer", (join) =>
      join
        .onRef("customer.organization_id", "=", "tickets.organization_id")
        .onRef("customer.id", "=", "tickets.customer_id"),
    )
    .leftJoin("teams as assigned_team", (join) =>
      join
        .onRef("assigned_team.organization_id", "=", "tickets.organization_id")
        .onRef("assigned_team.id", "=", "tickets.assigned_team_id"),
    )
    .leftJoin("users as assigned_agent", (join) =>
      join
        .onRef("assigned_agent.organization_id", "=", "tickets.organization_id")
        .onRef("assigned_agent.id", "=", "tickets.assigned_agent_id"),
    )
    .where("tickets.organization_id", "=", organizationId)
    .where("tickets.voided_at", "is", null)
    .select([
      "tickets.id",
      "tickets.subject",
      "tickets.status",
      "tickets.priority",
      "tickets.created_at as createdAt",
      "tickets.updated_at as updatedAt",
      "tickets.closed_at as closedAt",
      "customer.name as customerName",
      "assigned_team.id as assignedTeamId",
      "assigned_team.name as assignedTeamName",
      "assigned_agent.id as assignedAgentId",
      "assigned_agent.name as assignedAgentName",
    ]);
}

function agentTicketQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
) {
  return staffTicketQuery(executor, organizationId).where((eb) =>
    eb.or([
      eb("tickets.assigned_agent_id", "=", agentId),
      // Resolve current membership in the same statement/snapshot as ticket visibility.
      eb(
        "tickets.assigned_team_id",
        "=",
        eb
          .selectFrom("users as current_agent")
          .select("current_agent.team_id")
          .where("current_agent.organization_id", "=", organizationId)
          .where("current_agent.id", "=", agentId)
          .where("current_agent.role", "=", "AGENT"),
      ),
      eb.and([
        eb("tickets.assigned_agent_id", "is", null),
        eb("tickets.assigned_team_id", "is", null),
      ]),
    ]),
  );
}

async function paginateStaffTickets(
  query: ReturnType<typeof staffTicketQuery>,
  pagination: { page: number; limit: number },
) {
  const count = await query
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const tickets = await query
    .orderBy("tickets.created_at", "desc")
    .orderBy("tickets.id", "desc")
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit)
    .execute();
  return { tickets, total: Number(count.total) };
}

export async function listOrganizationTickets(
  executor: DatabaseExecutor,
  organizationId: string,
  pagination: { page: number; limit: number },
) {
  return paginateStaffTickets(
    staffTicketQuery(executor, organizationId),
    pagination,
  );
}

export async function listAgentTickets(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  pagination: { page: number; limit: number },
) {
  return paginateStaffTickets(
    agentTicketQuery(executor, organizationId, agentId),
    pagination,
  );
}

export async function findOrganizationTicketById(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return staffTicketQuery(executor, organizationId)
    .where("tickets.id", "=", ticketId)
    .select("customer.email as customerEmail")
    .executeTakeFirst();
}

export async function findAgentTicketById(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  ticketId: string,
) {
  return agentTicketQuery(executor, organizationId, agentId)
    .where("tickets.id", "=", ticketId)
    .select("customer.email as customerEmail")
    .executeTakeFirst();
}

export async function findAgentTicketForShare(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  ticketId: string,
) {
  return agentTicketQuery(executor, organizationId, agentId)
    .where("tickets.id", "=", ticketId)
    .clearSelect()
    .select("tickets.id")
    .forShare("tickets")
    .executeTakeFirst();
}
