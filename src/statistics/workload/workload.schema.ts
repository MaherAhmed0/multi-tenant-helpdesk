import { z } from "zod";

const count = z.number().int().nonnegative();

export const statisticsWorkloadSchema = z.object({
  generatedAt: z.iso.datetime(),
  assignment: z.object({
    fullyUnassigned: count,
    teamOnly: count,
    agentOnly: count,
    teamAndAgent: count,
  }).strict(),
  teams: z.array(z.object({
    teamId: z.uuid(),
    teamName: z.string(),
    activeTickets: count,
    teamOnlyTickets: count,
    teamAndAgentTickets: count,
  }).strict()),
  agents: z.array(z.object({
    agentId: z.uuid(),
    agentName: z.string(),
    activeAssignedTickets: count,
  }).strict()),
}).strict();

export type StatisticsWorkload = z.infer<typeof statisticsWorkloadSchema>;

export function isStatisticsWorkload(value: unknown): value is StatisticsWorkload {
  return statisticsWorkloadSchema.safeParse(value).success;
}
