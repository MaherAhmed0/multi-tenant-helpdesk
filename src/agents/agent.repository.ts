import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import type { AgentListInput } from "./agents.schema.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function agentQuery(executor: DatabaseExecutor, organizationId: string) {
  return (
    executor
      .selectFrom("users")
      // Keep an invalid team relationship visible so the service can fail on it.
      .leftJoin("teams", (join) =>
        join
          .onRef("teams.id", "=", "users.team_id")
          .onRef("teams.organization_id", "=", "users.organization_id"),
      )
      .where("users.organization_id", "=", organizationId)
      .where("users.role", "=", "AGENT")
      .select([
        "users.id",
        "users.name",
        "users.email",
        "users.deactivated_at as deactivatedAt",
        "users.created_at as createdAt",
        "teams.id as teamId",
        "teams.name as teamName",
        "teams.is_general as teamIsGeneral",
        "teams.deactivated_at as teamDeactivatedAt",
      ])
  );
}

export async function listAgents(
  executor: DatabaseExecutor,
  organizationId: string,
  input: AgentListInput,
) {
  let query = agentQuery(executor, organizationId);
  if (input.status) {
    query = query.where(
      "users.deactivated_at",
      input.status === "active" ? "is" : "is not",
      null,
    );
  }
  if (input.teamId) {
    query = query.where("users.team_id", "=", input.teamId);
  }
  if (input.search) {
    const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
    query = query.where((eb) =>
      eb.or([
        eb("users.name", "ilike", pattern),
        eb("users.email", "ilike", pattern),
      ]),
    );
  }

  const count = await query
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const agents = await query
    .orderBy("users.created_at", "desc")
    .orderBy("users.id", "desc")
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)
    .execute();
  return { agents, total: Number(count.total) };
}

export async function findAgent(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
) {
  return agentQuery(executor, organizationId)
    .where("users.id", "=", agentId)
    .executeTakeFirst();
}

export async function updateAgentTeam(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  teamId: string,
) {
  return executor
    .updateTable("users")
    .set({
      team_id: teamId,
      updated_at: sql<Date>`case when team_id is distinct from ${teamId}::uuid
        then clock_timestamp() else updated_at end`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", agentId)
    .where("role", "=", "AGENT")
    .returning("id")
    .executeTakeFirst();
}

export async function findAgentForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
) {
  return executor
    .selectFrom("users")
    .select(["id", "team_id as teamId", "deactivated_at as deactivatedAt"])
    .where("organization_id", "=", organizationId)
    .where("id", "=", agentId)
    .where("role", "=", "AGENT")
    .forUpdate()
    .executeTakeFirst();
}

export async function findAgentForShare(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
) {
  return executor
    .selectFrom("users")
    .select(["id", "team_id as teamId", "deactivated_at as deactivatedAt"])
    .where("organization_id", "=", organizationId)
    .where("id", "=", agentId)
    .where("role", "=", "AGENT")
    .forShare()
    .executeTakeFirst();
}

export async function markAgentDeactivated(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
) {
  return executor
    .updateTable("users")
    .set({
      deactivated_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", agentId)
    .where("role", "=", "AGENT")
    .where("deactivated_at", "is", null)
    .returning("id")
    .executeTakeFirstOrThrow();
}

export async function markAgentReactivated(
  executor: DatabaseExecutor,
  organizationId: string,
  agentId: string,
  teamId: string,
) {
  return executor
    .updateTable("users")
    .set({
      deactivated_at: null,
      team_id: teamId,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where("organization_id", "=", organizationId)
    .where("id", "=", agentId)
    .where("role", "=", "AGENT")
    .where("deactivated_at", "is not", null)
    .returning("id")
    .executeTakeFirstOrThrow();
}
