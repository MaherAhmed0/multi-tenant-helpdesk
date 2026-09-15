import { DatabaseError } from "pg";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  createNormalTeam,
  findTeam,
  listTeams as findTeams,
  renameNormalTeam,
  findTeamForUpdate,
  findGeneralTeam,
  markTeamDeactivated,
  markTeamReactivated,
} from "./team.repository.js";
import { moveActiveTeamAgents } from "./team-agent.repository.js";
import { clearTeamTicketAssignments } from "../tickets/ticket-assignment.repository.js";
import type { TeamListInput } from "./teams.schema.js";

function rethrowTeamWriteError(error: unknown): never {
  if (
    error instanceof DatabaseError &&
    error.code === "23505" &&
    error.constraint === "teams_organization_normalized_name_unique"
  ) {
    throw new AppError(409, "Team name already exists");
  }
  throw error;
}

export async function listTeams(organizationId: string, input: TeamListInput) {
  return { teams: await findTeams(db, organizationId, input) };
}

export async function getTeam(organizationId: string, teamId: string) {
  const team = await findTeam(db, organizationId, teamId);
  if (!team) throw new AppError(404, "Team not found");
  return team;
}

export async function createTeam(organizationId: string, name: string) {
  try {
    return await createNormalTeam(db, organizationId, name);
  } catch (error) {
    rethrowTeamWriteError(error);
  }
}

export async function renameTeam(
  organizationId: string,
  teamId: string,
  name: string,
) {
  const team = await getTeam(organizationId, teamId);
  if (team.isGeneral) throw new AppError(409, "General team cannot be renamed");
  try {
    const renamed = await renameNormalTeam(db, organizationId, teamId, name);
    if (!renamed) throw new AppError(404, "Team not found");
    return renamed;
  } catch (error) {
    rethrowTeamWriteError(error);
  }
}

export async function deactivateTeam(organizationId: string, teamId: string) {
  return db.transaction().execute(async (trx) => {
    // READ COMMITTED returns the current row after any competing lifecycle lock releases.
    const team = await findTeamForUpdate(trx, organizationId, teamId);
    if (!team) throw new AppError(404, "Team not found");
    if (team.isGeneral)
      throw new AppError(409, "General team cannot be deactivated");
    if (team.deactivatedAt !== null) return team;

    const general = await findGeneralTeam(trx, organizationId);
    if (!general) throw new Error("Organization General team is missing");

    await moveActiveTeamAgents(trx, organizationId, teamId, general.id);
    // Clear the old ticket team after locking/moving its active users, preserving
    // valid individual assignees. Both changes become visible together at commit.
    await clearTeamTicketAssignments(trx, organizationId, teamId);
    return markTeamDeactivated(trx, organizationId, teamId);
  });
}

export async function reactivateTeam(organizationId: string, teamId: string) {
  return db.transaction().execute(async (trx) => {
    const team = await findTeamForUpdate(trx, organizationId, teamId);
    if (!team) throw new AppError(404, "Team not found");
    if (team.deactivatedAt === null) return team;

    return markTeamReactivated(trx, organizationId, teamId);
  });
}
