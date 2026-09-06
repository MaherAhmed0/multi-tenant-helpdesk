import { z } from "zod";

export const loginSchema = z
  .object({
    organizationSlug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),

    email: z.string().trim().toLowerCase().email().max(254),

    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
