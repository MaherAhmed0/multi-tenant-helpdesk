import { z } from "zod";

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(255),
    message: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const ticketParamsSchema = z.object({ ticketId: z.uuid() }).strict();
export const ticketClaimSchema = z.object({}).strict();
export const ticketReleaseSchema = z.object({}).strict();
export const ticketAssignmentSchema = z.object({
  teamId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
}).strict();
export type TicketAssignmentInput = z.infer<typeof ticketAssignmentSchema>;

export const ticketStatusSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
}).strict();

export const ticketPrioritySchema = z.object({
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
}).strict();

export const ticketMessageSchema = createTicketSchema
  .pick({ message: true })
  .strict();
export type TicketMessageInput = z.infer<typeof ticketMessageSchema>;

export const ticketListSchema = z
  .object({
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

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type TicketListInput = z.infer<typeof ticketListSchema>;
