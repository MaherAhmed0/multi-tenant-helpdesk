import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  ticketParamsSchema,
  ticketNoteParamsSchema,
  ticketNoteSchema,
} from "./tickets.schema.js";
import {
  getTicketNotes,
  addTicketNote,
  editTicketNote,
} from "./ticket-notes.service.js";

export async function listTicketNotesController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const result = await getTicketNotes(req.auth, params.data.ticketId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(result);
}

export async function createTicketNoteController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket ID", params.error.issues);
  const body = ticketNoteSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid internal note", body.error.issues);
  const result = await addTicketNote(
    req.auth,
    params.data.ticketId,
    body.data.body,
  );
  res.set("Cache-Control", "no-store");
  res.status(201).json(result);
}

export async function editTicketNoteController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = ticketNoteParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid ticket or note ID", params.error.issues);
  const body = ticketNoteSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid internal note", body.error.issues);
  const result = await editTicketNote(
    req.auth,
    params.data.ticketId,
    params.data.noteId,
    body.data.body,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(result);
}
