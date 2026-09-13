import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";
import type { TeamListInput } from "./teams.schema.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const teamFields = [
  "id",
  "name",
  "is_general as isGeneral",
  "deactivated_at as deactivatedAt",
  "created_at as createdAt",
] as const;

export async function listTeams(
  executor: DatabaseExecutor,
  organizationId: string,
  input: TeamListInput,
) {
  let query = executor
    .selectFrom("teams")
    .select(teamFields)
    .where("organization_id", "=", organizationId);
  if (input.status) {
    query = query.where(
      "deactivated_at",
      input.status === "active" ? "is" : "is not",
      null,
    );
  }
  return query
    .orderBy("is_general", "desc")
    .orderBy(sql`lower(btrim(name))`, "asc")
    .orderBy("id", "asc")
    .execute();
}

export async function findTeam(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
) {
  return executor
    .selectFrom("teams")
    .select(teamFields)
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .executeTakeFirst();
}

export async function createNormalTeam(
  executor: DatabaseExecutor,
  organizationId: string,
  name: string,
) {
  return executor
    .insertInto("teams")
    .values({
      organization_id: organizationId,
      name,
      is_general: false,
      deactivated_at: null,
    })
    .returning(teamFields)
    .executeTakeFirstOrThrow();
}

export async function renameNormalTeam(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
  name: string,
) {
  return executor
    .updateTable("teams")
    .set({ name })
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .where("is_general", "=", false)
    .returning(teamFields)
    .executeTakeFirst();
}

export async function createGeneralTeam(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .insertInto("teams")
    .values({
      organization_id: organizationId,
      name: "General",
      is_general: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

export async function findTeamForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
) {
  return executor
    .selectFrom("teams")
    .select(teamFields)
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .forUpdate()
    .executeTakeFirst();
}

export async function findTeamForShare(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
) {
  return executor
    .selectFrom("teams")
    .select(teamFields)
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .forShare()
    .executeTakeFirst();
}

export async function findGeneralTeam(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .selectFrom("teams")
    .select("id")
    .where("organization_id", "=", organizationId)
    .where("is_general", "=", true)
    .executeTakeFirst();
}

export async function markTeamDeactivated(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
) {
  return executor
    .updateTable("teams")
    .set({ deactivated_at: sql<Date>`clock_timestamp()` })
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .where("is_general", "=", false)
    .where("deactivated_at", "is", null)
    .returning(teamFields)
    .executeTakeFirstOrThrow();
}

export async function markTeamReactivated(
  executor: DatabaseExecutor,
  organizationId: string,
  teamId: string,
) {
  return executor
    .updateTable("teams")
    .set({ deactivated_at: null })
    .where("organization_id", "=", organizationId)
    .where("id", "=", teamId)
    .where("deactivated_at", "is not", null)
    .returning(teamFields)
    .executeTakeFirstOrThrow();
}
