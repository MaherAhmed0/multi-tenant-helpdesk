import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  createTicketSchema,
  ticketListSchema,
  ticketParamsSchema,
  ticketClaimSchema,
  ticketReleaseSchema,
  ticketAssignmentSchema,
  ticketMessageSchema,
  ticketStatusSchema,
  ticketPrioritySchema,
} from "./tickets.schema.js";
import {
  createCustomerTicket,
  getTicket,
  listTickets,
  claimTicket,
  releaseTicket,
  updateTicketAssignment,
  addTicketMessage,
  updateTicketStatus,
  updateTicketPriority,
} from "./tickets.service.js";

export async function createTicketController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const body = createTicketSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid ticket data", body.error.issues);
  const ticket = await createCustomerTicket(req.auth, body.data);
  res.set("Cache-Control", "no-store");
  res.status(201).json(ticket);
}

export async function listTicketsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const query = ticketListSchema.safeParse(req.query);
  if (!query.success)
    throw new AppError(400, "Invalid ticket query", query.error.issues);
  const result = await listTickets(req.auth, query.data);
  res.set("Cache-Control", "no-store");
  res.status(200).json(result);
}

export async function getTicketController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const ticket = await getTicket(req.auth, params.data.ticketId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function claimTicketController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketClaimSchema.safeParse(req.body ?? {});
  if (!body.success)
    throw new AppError(400, "Invalid ticket claim", body.error.issues);
  const ticket = await claimTicket(req.auth, params.data.ticketId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function releaseTicketController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketReleaseSchema.safeParse(req.body ?? {});
  if (!body.success)
    throw new AppError(400, "Invalid ticket release", body.error.issues);
  const ticket = await releaseTicket(req.auth, params.data.ticketId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function updateTicketAssignmentController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketAssignmentSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid ticket assignment", body.error.issues);
  const ticket = await updateTicketAssignment(
    req.auth,
    params.data.ticketId,
    body.data,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function updateTicketStatusController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketStatusSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid ticket status", body.error.issues);
  const ticket = await updateTicketStatus(
    req.auth,
    params.data.ticketId,
    body.data.status,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function updateTicketPriorityController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketPrioritySchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid ticket priority", body.error.issues);
  const ticket = await updateTicketPriority(
    req.auth,
    params.data.ticketId,
    body.data.priority,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(ticket);
}

export async function addTicketMessageController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketMessageSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid ticket message", body.error.issues);
  const result = await addTicketMessage(
    req.auth,
    params.data.ticketId,
    body.data,
  );
  res.set("Cache-Control", "no-store");
  res.status(201).json(result);
}
