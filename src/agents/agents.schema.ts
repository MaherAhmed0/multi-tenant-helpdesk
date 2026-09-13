import { z } from "zod";

export const agentListSchema = z
  .object({
    status: z.enum(["active", "deactivated"]).optional(),
    teamId: z.uuid().optional(),
    search: z.string().trim().min(1).max(255).optional(),
    page: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(1_000_000))
      .default(1),
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(20),
  })
  .strict();

export const agentParamsSchema = z.object({ agentId: z.uuid() }).strict();

export const agentTeamSchema = z.object({ teamId: z.uuid() }).strict();

export type AgentListInput = z.infer<typeof agentListSchema>;
