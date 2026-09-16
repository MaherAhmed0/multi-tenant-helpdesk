import type { AuthContext } from "../auth/sessions/session-auth.service.js";
import { findAgentForShare } from "../agents/agent.repository.js";
import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  findAgentTicketById,
  findAgentTicketForShare,
  findOrganizationTicketById,
} from "./staff-ticket.repository.js";
import {
  createTicketNote,
  listTicketNotes,
  updateOwnTicketNote,
  findOrganizationTicketForNoteShare,
  findAgentTicketForNoteCreationShare,
} from "./ticket-note.repository.js";

function requireStaff(auth: AuthContext) {
  if (auth.role !== "AGENT" && auth.role !== "ORGANIZATION_ADMIN")
    throw new AppError(403, "Request forbidden");
}

function staffNote(note: Awaited<ReturnType<typeof createTicketNote>>) {
  return {
    id: note.id,
    body: note.body,
    author: { id: note.authorId, name: note.authorName },
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export async function getTicketNotes(auth: AuthContext, ticketId: string) {
  requireStaff(auth);

  return db.transaction().execute(async (trx) => {
    if (auth.role === "AGENT") {
      const agent = await findAgentForShare(
        trx,
        auth.organizationId,
        auth.userId,
      );

      if (!agent || agent.deactivatedAt) {
        throw new AppError(401, "Authentication required");
      }

      const ticket = await findAgentTicketForShare(
        trx,
        auth.organizationId,
        auth.userId,
        ticketId,
      );

      if (!ticket) {
        throw new AppError(404, "Ticket not found");
      }
    } else {
      const ticket = await findOrganizationTicketForNoteShare(
        trx,
        auth.organizationId,
        ticketId,
      );

      if (!ticket) {
        throw new AppError(404, "Ticket not found");
      }
    }

    return {
      notes: (await listTicketNotes(trx, auth.organizationId, ticketId)).map(
        staffNote,
      ),
    };
  });
}

export async function addTicketNote(
  auth: AuthContext,
  ticketId: string,
  body: string,
) {
  requireStaff(auth);
  return db.transaction().execute(async (trx) => {
    if (auth.role === "AGENT") {
      const agent = await findAgentForShare(
        trx,
        auth.organizationId,
        auth.userId,
      );
      if (!agent || agent.deactivatedAt)
        throw new AppError(401, "Authentication required");
      if (
        !(await findAgentTicketById(
          trx,
          auth.organizationId,
          auth.userId,
          ticketId,
        ))
      )
        throw new AppError(404, "Ticket not found");
      const ticket = await findAgentTicketForNoteCreationShare(
        trx,
        auth.organizationId,
        ticketId,
        auth.userId,
        agent.teamId,
      );
      if (!ticket) {
        if (
          !(await findAgentTicketById(
            trx,
            auth.organizationId,
            auth.userId,
            ticketId,
          ))
        )
          throw new AppError(404, "Ticket not found");
        throw new AppError(409, "Cannot add an internal note to this ticket");
      }
    } else if (
      !(await findOrganizationTicketForNoteShare(
        trx,
        auth.organizationId,
        ticketId,
      ))
    ) {
      throw new AppError(404, "Ticket not found");
    }
    // Shared ticket lock protects authorization without touching customer-visible activity.
    return staffNote(
      await createTicketNote(trx, {
        organizationId: auth.organizationId,
        ticketId,
        authorId: auth.userId,
        body,
      }),
    );
  });
}

export async function editTicketNote(
  auth: AuthContext,
  ticketId: string,
  noteId: string,
  body: string,
) {
  requireStaff(auth);
  return db.transaction().execute(async (trx) => {
    if (auth.role === "AGENT") {
      const agent = await findAgentForShare(
        trx,
        auth.organizationId,
        auth.userId,
      );
      if (!agent || agent.deactivatedAt)
        throw new AppError(401, "Authentication required");
      if (
        !(await findAgentTicketForShare(
          trx,
          auth.organizationId,
          auth.userId,
          ticketId,
        ))
      )
        throw new AppError(404, "Ticket not found");
    } else if (
      !(await findOrganizationTicketForNoteShare(
        trx,
        auth.organizationId,
        ticketId,
      ))
    ) {
      throw new AppError(404, "Ticket not found");
    }
    const note = await updateOwnTicketNote(trx, {
      organizationId: auth.organizationId,
      ticketId,
      noteId,
      authorId: auth.userId,
      body,
    });
    if (!note) throw new AppError(404, "Internal note not found");
    return staffNote(note);
  });
}
