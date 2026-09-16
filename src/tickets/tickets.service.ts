import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import {
  findOrganizationTicketForReplyUpdate,
  findAgentTicketForReplyUpdate,
  touchStaffReplyTicket,
} from "./ticket-reply.repository.js";
import {
  attemptClaimTicket,
  attemptReleaseTicket,
  replaceTicketAssignment,
} from "./ticket-assignment.repository.js";
import { findAgentForShare } from "../agents/agent.repository.js";
import { findTeamForShare } from "../teams/team.repository.js";
import type { TicketPriority, TicketStatus } from "../database/types.js";
import {
  attemptAdminPriorityUpdate,
  attemptAgentPriorityUpdate,
} from "./ticket-priority.repository.js";
import {
  attemptAdminStatusTransition,
  attemptAgentStatusTransition,
} from "./ticket-status.repository.js";
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
  TicketAssignmentInput,
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

export async function releaseTicket(auth: AuthContext, ticketId: string) {
  if (auth.role !== "AGENT") throw new AppError(403, "Request forbidden");
  const visible = await findAgentTicketById(
    db,
    auth.organizationId,
    auth.userId,
    ticketId,
  );
  if (!visible) throw new AppError(404, "Ticket not found");
  const released = await attemptReleaseTicket(
    db,
    auth.organizationId,
    auth.userId,
    ticketId,
  );
  if (!released) throw new AppError(409, "Ticket is not releasable");
  return staffTicket(released);
}

export async function updateTicketAssignment(
  auth: AuthContext,
  ticketId: string,
  input: TicketAssignmentInput,
) {
  if (auth.role !== "ORGANIZATION_ADMIN")
    throw new AppError(403, "Request forbidden");
  return db.transaction().execute(async (trx) => {
    const visible = await findOrganizationTicketById(
      trx,
      auth.organizationId,
      ticketId,
    );
    if (!visible) throw new AppError(404, "Ticket not found");

    // Referenced team -> agent -> ticket, matching team lifecycle and reassignment.
    // Hold validation locks until the conditional ticket UPDATE commits.
    if (input.teamId !== null) {
      const team = await findTeamForShare(
        trx,
        auth.organizationId,
        input.teamId,
      );
      if (!team) throw new AppError(404, "Team not found");
      if (team.deactivatedAt !== null)
        throw new AppError(409, "Cannot assign a deactivated team");
    }
    if (input.agentId !== null) {
      const agent = await findAgentForShare(
        trx,
        auth.organizationId,
        input.agentId,
      );
      if (!agent) throw new AppError(404, "Agent not found");
      if (agent.deactivatedAt !== null)
        throw new AppError(409, "Cannot assign a deactivated agent");
      if (input.teamId !== null && agent.teamId !== input.teamId) {
        throw new AppError(409, "Agent does not belong to the selected team");
      }
    }
    const updated = await replaceTicketAssignment(
      trx,
      auth.organizationId,
      ticketId,
      input,
    );
    if (!updated)
      throw new AppError(409, "Ticket assignment cannot be changed");
    return staffTicket(updated);
  });
}

const statusTransitions: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: ["OPEN"],
};

function requireStatusTransition(
  source: TicketStatus,
  target: TicketStatus,
): void {
  if (!statusTransitions[source].includes(target)) {
    throw new AppError(409, "Ticket status cannot be changed");
  }
}

export async function updateTicketStatus(
  auth: AuthContext,
  ticketId: string,
  target: TicketStatus,
) {
  switch (auth.role) {
    case "ORGANIZATION_ADMIN": {
      const visible = await findOrganizationTicketById(
        db,
        auth.organizationId,
        ticketId,
      );
      if (!visible) throw new AppError(404, "Ticket not found");
      requireStatusTransition(visible.status, target);
      const updated = await attemptAdminStatusTransition(
        db,
        auth.organizationId,
        ticketId,
        visible.status,
        target,
      );
      if (!updated) throw new AppError(409, "Ticket status cannot be changed");
      return staffTicket(updated);
    }
    case "AGENT":
      return db.transaction().execute(async (trx) => {
        // User before ticket, as in claim and lifecycle cleanup. No team lock needed.
        const agent = await findAgentForShare(
          trx,
          auth.organizationId,
          auth.userId,
        );
        if (!agent || agent.deactivatedAt !== null)
          throw new AppError(401, "Authentication required");
        const visible = await findAgentTicketById(
          trx,
          auth.organizationId,
          agent.id,
          ticketId,
        );
        if (!visible) throw new AppError(404, "Ticket not found");
        requireStatusTransition(visible.status, target);
        const updated = await attemptAgentStatusTransition(
          trx,
          auth.organizationId,
          ticketId,
          visible.status,
          target,
          agent,
        );
        if (!updated)
          throw new AppError(409, "Ticket status cannot be changed");
        return staffTicket(updated);
      });
    default:
      throw new AppError(403, "Request forbidden");
  }
}

export async function updateTicketPriority(
  auth: AuthContext,
  ticketId: string,
  priority: TicketPriority,
) {
  switch (auth.role) {
    case "ORGANIZATION_ADMIN": {
      const visible = await findOrganizationTicketById(
        db,
        auth.organizationId,
        ticketId,
      );
      if (!visible) throw new AppError(404, "Ticket not found");
      const updated = await attemptAdminPriorityUpdate(
        db,
        auth.organizationId,
        ticketId,
        priority,
      );
      if (!updated)
        throw new AppError(409, "Ticket priority cannot be changed");
      return staffTicket(updated);
    }
    case "AGENT":
      return db.transaction().execute(async (trx) => {
        // Keep active-agent state and current membership stable through the UPDATE.
        // User before ticket follows the existing status/lifecycle lock order.
        const agent = await findAgentForShare(
          trx,
          auth.organizationId,
          auth.userId,
        );
        if (!agent || agent.deactivatedAt !== null)
          throw new AppError(401, "Authentication required");
        const visible = await findAgentTicketById(
          trx,
          auth.organizationId,
          agent.id,
          ticketId,
        );
        if (!visible) throw new AppError(404, "Ticket not found");
        const updated = await attemptAgentPriorityUpdate(
          trx,
          auth.organizationId,
          ticketId,
          priority,
          agent,
        );
        if (!updated)
          throw new AppError(409, "Ticket priority cannot be changed");
        return staffTicket(updated);
      });
    default:
      throw new AppError(403, "Request forbidden");
  }
}

export async function addTicketMessage(
  auth: AuthContext,
  ticketId: string,
  input: TicketMessageInput,
) {
  if (auth.role === "CUSTOMER")
    return addCustomerMessage(auth, ticketId, input);
  if (auth.role !== "AGENT" && auth.role !== "ORGANIZATION_ADMIN") {
    throw new AppError(403, "Request forbidden");
  }
  return db.transaction().execute(async (trx) => {
    let ticket;
    if (auth.role === "AGENT") {
      // Match lifecycle lock order: actor first, then the authorized ticket row.
      const agent = await findAgentForShare(
        trx,
        auth.organizationId,
        auth.userId,
      );
      if (!agent || agent.deactivatedAt !== null)
        throw new AppError(401, "Authentication required");
      const visible = await findAgentTicketById(
        trx,
        auth.organizationId,
        agent.id,
        ticketId,
      );
      if (!visible) throw new AppError(404, "Ticket not found");
      ticket = await findAgentTicketForReplyUpdate(
        trx,
        auth.organizationId,
        ticketId,
        agent,
      );
      if (!ticket) throw new AppError(409, "Cannot reply to this ticket");
    } else {
      ticket = await findOrganizationTicketForReplyUpdate(
        trx,
        auth.organizationId,
        ticketId,
      );
      if (!ticket) throw new AppError(404, "Ticket not found");
    }
    // Read the current status after acquiring the ticket lock, including after waits.
    if (ticket.status === "CLOSED")
      throw new AppError(409, "Cannot reply to a closed ticket");
    const message = await createTicketMessage(trx, {
      organizationId: auth.organizationId,
      ticketId: ticket.id,
      authorUserId: auth.userId,
      body: input.message,
    });
    const updated = await touchStaffReplyTicket(
      trx,
      auth.organizationId,
      ticket.id,
    );
    return { message: publicMessage(message), ticketStatus: updated.status };
  });
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
