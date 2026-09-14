import { z } from "zod";

import { registrationSchema } from "../organization-registration/registration.schema.js";

export const publicOrganizationParamsSchema = z.object({
  slug: registrationSchema.shape.organizationSlug,
}).strict();

export const customerRegistrationSchema = z.object({
  name: registrationSchema.shape.adminName,
  email: registrationSchema.shape.adminEmail,
  password: registrationSchema.shape.adminPassword,
}).strict();

export type CustomerRegistrationInput = z.infer<typeof customerRegistrationSchema>;
