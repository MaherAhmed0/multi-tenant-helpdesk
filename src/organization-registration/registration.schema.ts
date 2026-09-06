import { z } from "zod";

export const registrationSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(255),

    organizationSlug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),

    adminName: z.string().trim().min(1).max(255),

    adminEmail: z.string().trim().toLowerCase().email().max(254),

    adminPassword: z.string().min(15).max(128),
  })
  .strict();

export type RegistrationInput = z.infer<typeof registrationSchema>;
