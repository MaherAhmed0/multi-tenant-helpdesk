import { z } from "zod";

export const organizationListSchema = z
  .object({
    search: z.string().trim().min(1).max(255).optional(),
    status: z.enum(["active", "deactivated"]).optional(),
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

export const organizationParamsSchema = z
  .object({
    organizationId: z.uuid(),
  })
  .strict();

export type OrganizationListInput = z.infer<typeof organizationListSchema>;
