import { z } from "zod";

export const mfaSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
}).strict();
