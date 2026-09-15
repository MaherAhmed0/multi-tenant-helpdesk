import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  findAgent,
  listAgents as findAgents,
  updateAgentTeam,
  findAgentForUpdate,
  markAgentDeactivated,
  markAgentReactivated,
} from "./agent.repository.js";
import { findTeamForShare, findGeneralTeam } from "../teams/team.repository.js";
import { revokeAccountSessions } from "../auth/sessions/session.repository.js";
import { clearAgentTicketAssignments, clearIncompatibleAgentTicketAssignments } from "../tickets/ticket-assignment.repository.js";
import type { AgentListInput } from "./agents.schema.js";

type AgentRow = NonNullable<Awaited<ReturnType<typeof findAgent>>>;

function agentRepresentation(agent: AgentRow) {
  if (
    agent.teamId === null ||
    agent.teamName === null ||
    agent.teamIsGeneral === null
  ) {
    throw new Error("Agent team is missing");
  }
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    deactivatedAt: agent.deactivatedAt,
    createdAt: agent.createdAt,
    team: {
      id: agent.teamId,
      name: agent.teamName,
      isGeneral: agent.teamIsGeneral,
      deactivatedAt: agent.teamDeactivatedAt,
    },
  };
}

export async function listAgents(
  organizationId: string,
  input: AgentListInput,
) {
  const { agents, total } = await findAgents(db, organizationId, input);
  return {
    agents: agents.map(agentRepresentation),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export async function getAgent(organizationId: string, agentId: string) {
  const agent = await findAgent(db, organizationId, agentId);
  if (!agent) throw new AppError(404, "Agent not found");
  return agentRepresentation(agent);
}

export async function reassignAgentTeam(
  organizationId: string,
  agentId: string,
  teamId: string,
) {
  return db.transaction().execute(async (trx) => {
    // Hold destination eligibility stable against team lifecycle FOR UPDATE locks.
    const team = await findTeamForShare(trx, organizationId, teamId);
    if (!team) throw new AppError(404, "Team not found");
    if (team.deactivatedAt !== null) {
      throw new AppError(409, "Cannot assign an agent to a deactivated team");
    }

    const updated = await updateAgentTeam(trx, organizationId, agentId, teamId);
    if (!updated) throw new AppError(404, "Agent not found");
    await clearIncompatibleAgentTicketAssignments(trx, organizationId, agentId, teamId);
    const agent = await findAgent(trx, organizationId, agentId);
    if (!agent) throw new Error("Updated agent is missing");
    return agentRepresentation(agent);
  });
}

export async function deactivateAgent(organizationId: string, agentId: string) {
  return db.transaction().execute(async (trx) => {
    const locked = await findAgentForUpdate(trx, organizationId, agentId);
    if (!locked) throw new AppError(404, "Agent not found");
    if (locked.deactivatedAt === null) {
      await markAgentDeactivated(trx, organizationId, locked.id);
    }
    // Repeated deactivation must also revoke any sessions created since the last call.
    await revokeAccountSessions(trx, {
      organizationId,
      userId: locked.id,
      revokedAt: new Date(),
    });
    await clearAgentTicketAssignments(trx, organizationId, locked.id);
    const agent = await findAgent(trx, organizationId, locked.id);
    if (!agent) throw new Error("Updated agent is missing");
    return agentRepresentation(agent);
  });
}

export async function reactivateAgent(organizationId: string, agentId: string) {
  return db.transaction().execute(async (trx) => {
    const locked = await findAgentForUpdate(trx, organizationId, agentId);
    if (!locked) throw new AppError(404, "Agent not found");
    if (locked.deactivatedAt !== null) {
      if (locked.teamId === null) throw new Error("Agent team is missing");
      const retained = await findTeamForShare(
        trx,
        organizationId,
        locked.teamId,
      );
      if (!retained) throw new Error("Agent team is missing");
      let teamId = retained.id;
      if (retained.deactivatedAt !== null) {
        const general = await findGeneralTeam(trx, organizationId);
        if (!general) throw new Error("Organization General team is missing");
        teamId = general.id;
      }
      await markAgentReactivated(trx, organizationId, locked.id, teamId);
    }
    const agent = await findAgent(trx, organizationId, locked.id);
    if (!agent) throw new Error("Updated agent is missing");
    return agentRepresentation(agent);
  });
}

export async function revokeAgentSessions(
  organizationId: string,
  agentId: string,
): Promise<void> {
  const agent = await findAgent(db, organizationId, agentId);
  if (!agent) throw new AppError(404, "Agent not found");
  await revokeAccountSessions(db, {
    organizationId,
    userId: agent.id,
    revokedAt: new Date(),
  });
}
