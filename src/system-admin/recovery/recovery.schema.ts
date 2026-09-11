import { z } from "zod";

export const recoverySchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();
