import { z } from "zod";

import { registrationSchema } from "../organization-registration/registration.schema.js";

export const acceptanceSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: registrationSchema.shape.adminPassword,
}).strict();

export type AcceptanceInput = z.infer<typeof acceptanceSchema>;
