import { z } from "zod";

import { registrationSchema } from "../../organization-registration/registration.schema.js";

export const provisioningSchema = z
  .object({
    email: registrationSchema.shape.adminEmail,
    password: registrationSchema.shape.adminPassword,
    // Confirmation belongs to the trusted caller; do not alter the supplied secret.
    confirmedTotpSecret: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

export type ProvisioningInput = z.infer<typeof provisioningSchema>;
