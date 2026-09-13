import { z } from "zod";

export const teamListSchema = z
  .object({
    status: z.enum(["active", "deactivated"]).optional(),
  })
  .strict();

export const teamParamsSchema = z.object({ teamId: z.uuid() }).strict();

export const teamNameSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export type TeamListInput = z.infer<typeof teamListSchema>;
