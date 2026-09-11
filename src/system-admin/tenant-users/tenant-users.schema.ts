import { z } from "zod";

export const tenantUserParamsSchema = z.object({ userId: z.uuid() }).strict();
