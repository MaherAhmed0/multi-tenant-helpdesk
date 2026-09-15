import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { attemptClaimTicket } from "./ticket-assignment.repository.js";
import type { AuthContext } from "../auth/sessions/session-auth.service.js";
import {
  createTicket,
  findCustomerTicketById,
  listCustomerTickets,
  findCustomerTicketForUpdate,
  reopenResolvedTicket,
  touchTicket,
} from "./ticket.repository.js";
import {
  createTicketMessage,
  listTicketMessages,
} from "./ticket-message.repository.js";
import {
  listOrganizationTickets,
  listAgentTickets,
  findOrganizationTicketById,
  findAgentTicketById,
} from "./staff-ticket.repository.js";
import type {
  CreateTicketInput,
  TicketListInput,
  TicketMessageInput,
} from "./tickets.schema.js";

function publicMessage(
  message: Awaited<ReturnType<typeof createTicketMessage>>,
) {
  return {
    id: message.id,
    body: message.body,
    author: {
      name: message.authorName,
      type:
        message.authorRole === "CUSTOMER"
          ? ("CUSTOMER" as const)
          : ("STAFF" as const),
    },
    createdAt: message.createdAt,
  };
}

// Account activity is established by tenant authentication on each request.
export async function createCustomerTicket(
  auth: AuthContext,
  input: CreateTicketInput,
) {
  if (auth.role !== "CUSTOMER") throw new AppError(403, "Request forbidden");
  return db.transaction().execute(async (trx) => {
    const ticket = await createTicket(trx, {
      organizationId: auth.organizationId,
      customerId: auth.userId,
      subject: input.subject,
    });
    const message = await createTicketMessage(trx, {
      organizationId: auth.organizationId,
      ticketId: ticket.id,
      authorUserId: auth.userId,
      body: input.message,
    });
    return { ...ticket, messages: [publicMessage(message)] };
  });
}

function staffTicket(
  ticket: Awaited<
    ReturnType<typeof listOrganizationTickets>
  >["tickets"][number],
) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt,
    customer: { name: ticket.customerName },
    assignedTeam:
      ticket.assignedTeamId === null
        ? null
        : { id: ticket.assignedTeamId, name: ticket.assignedTeamName },
    assignedAgent:
      ticket.assignedAgentId === null
        ? null
        : { id: ticket.assignedAgentId, name: ticket.assignedAgentName },
  };
}

async function listVisibleTickets(auth: AuthContext, input: TicketListInput) {
  switch (auth.role) {
    case "CUSTOMER":
      return listCustomerTickets(db, auth.organizationId, auth.userId, input);
    case "AGENT": {
      const result = await listAgentTickets(
        db,
        auth.organizationId,
        auth.userId,
        input,
      );
      return { tickets: result.tickets.map(staffTicket), total: result.total };
    }
    case "ORGANIZATION_ADMIN": {
      const result = await listOrganizationTickets(
        db,
        auth.organizationId,
        input,
      );
      return { tickets: result.tickets.map(staffTicket), total: result.total };
    }
    default:
      throw new AppError(403, "Request forbidden");
  }
}

export async function listTickets(auth: AuthContext, input: TicketListInput) {
  const { tickets, total } = await listVisibleTickets(auth, input);
  return {
    tickets,
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
}

export async function getTicket(auth: AuthContext, ticketId: string) {
  let ticket;
  switch (auth.role) {
    case "CUSTOMER":
      ticket = await findCustomerTicketById(
        db,
        auth.organizationId,
        auth.userId,
        ticketId,
      );
      break;
    case "AGENT":
    case "ORGANIZATION_ADMIN": {
      const row =
        auth.role === "AGENT"
          ? await findAgentTicketById(
              db,
              auth.organizationId,
              auth.userId,
              ticketId,
            )
          : await findOrganizationTicketById(db, auth.organizationId, ticketId);
      if (row)
        ticket = {
          ...staffTicket(row),
          customer: { name: row.customerName, email: row.customerEmail },
        };
      break;
    }
    default:
      throw new AppError(403, "Request forbidden");
  }
  if (!ticket) throw new AppError(404, "Ticket not found");
  const messages = await listTicketMessages(db, auth.organizationId, ticket.id);
  return { ...ticket, messages: messages.map(publicMessage) };
}

export async function claimTicket(auth: AuthContext, ticketId: string) {
  if (auth.role !== "AGENT") throw new AppError(403, "Request forbidden");
  const visible = await findAgentTicketById(
    db,
    auth.organizationId,
    auth.userId,
    ticketId,
  );
  if (!visible) throw new AppError(404, "Ticket not found");
  const claimed = await attemptClaimTicket(
    db,
    auth.organizationId,
    auth.userId,
    ticketId,
  );
  if (!claimed) throw new AppError(409, "Ticket is not claimable");
  return staffTicket(claimed);
}

export async function addCustomerMessage(
  auth: AuthContext,
  ticketId: string,
  input: TicketMessageInput,
) {
  if (auth.role !== "CUSTOMER") throw new AppError(403, "Request forbidden");
  return db.transaction().execute(async (trx) => {
    // Serialize status-dependent replies with concurrent ticket closure/voiding.
    // Keep this ticket lock until both the message and ticket update commit.
    const ticket = await findCustomerTicketForUpdate(
      trx,
      auth.organizationId,
      auth.userId,
      ticketId,
    );
    if (!ticket) throw new AppError(404, "Ticket not found");
    if (ticket.status === "CLOSED")
      throw new AppError(409, "Cannot reply to a closed ticket");

    const message = await createTicketMessage(trx, {
      organizationId: auth.organizationId,
      ticketId: ticket.id,
      authorUserId: auth.userId,
      body: input.message,
    });
    const updated =
      ticket.status === "RESOLVED"
        ? await reopenResolvedTicket(
            trx,
            auth.organizationId,
            auth.userId,
            ticket.id,
          )
        : await touchTicket(trx, auth.organizationId, auth.userId, ticket.id);
    return { message: publicMessage(message), ticketStatus: updated.status };
  });
}
