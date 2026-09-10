import { z } from "zod";

export const systemAdminLoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z.string().min(1).max(128),
  })
  .strict();

export type SystemAdminLoginInput = z.infer<typeof systemAdminLoginSchema>;
