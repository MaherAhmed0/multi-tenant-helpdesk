import { z } from "zod";

export const createInvitationSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    teamId: z.uuid().optional(),
  })
  .strict();

export const invitationParamsSchema = z
  .object({ invitationId: z.uuid() })
  .strict();

export const invitationListSchema = z
  .object({
    status: z.enum(["pending", "expired", "revoked", "consumed"]).optional(),
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
