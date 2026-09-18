import { db } from "../../database/db.js";
import {
  aggregateWorkloadAssignment,
  aggregateTeamWorkload,
  aggregateAgentWorkload,
} from "./workload.repository.js";
import {
  isStatisticsWorkload,
  statisticsWorkloadSchema,
} from "./workload.schema.js";
import { readWorkloadCache, writeWorkloadCache } from "../statistics.cache.js";

export async function getStatisticsWorkload(organizationId: string) {
  const cached = await readWorkloadCache(organizationId, isStatisticsWorkload);
  if (cached.status === "HIT") {
    return { workload: cached.value, cacheStatus: cached.status };
  }

  // Observational statistics: each query may see a slightly different snapshot.
  const [assignment, teams, agents] = await Promise.all([
    aggregateWorkloadAssignment(db, organizationId),
    aggregateTeamWorkload(db, organizationId),
    aggregateAgentWorkload(db, organizationId),
  ]);
  const workload = statisticsWorkloadSchema.parse({
    generatedAt: assignment.generatedAt.toISOString(),
    assignment: {
      fullyUnassigned: Number(assignment.fullyUnassigned),
      teamOnly: Number(assignment.teamOnly),
      agentOnly: Number(assignment.agentOnly),
      teamAndAgent: Number(assignment.teamAndAgent),
    },
    teams: teams.map((team) => ({
      teamId: team.teamId,
      teamName: team.teamName,
      activeTickets: Number(team.activeTickets),
      teamOnlyTickets: Number(team.teamOnlyTickets),
      teamAndAgentTickets: Number(team.teamAndAgentTickets),
    })),
    agents: agents.map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.agentName,
      activeAssignedTickets: Number(agent.activeAssignedTickets),
    })),
  });

  if (cached.status === "MISS") {
    await writeWorkloadCache(organizationId, workload);
  }
  return { workload, cacheStatus: cached.status };
}
