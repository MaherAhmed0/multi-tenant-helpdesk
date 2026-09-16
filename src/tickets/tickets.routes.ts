import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireCustomer } from "../auth/customer.middleware.js";
import { requireAgent } from "../auth/agent.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  listTicketNotesController,
  createTicketNoteController,
  editTicketNoteController,
} from "./ticket-notes.controller.js";
import {
  createTicketController,
  getTicketController,
  listTicketsController,
  addTicketMessageController,
  claimTicketController,
  releaseTicketController,
  updateTicketAssignmentController,
  updateTicketStatusController,
  updateTicketPriorityController,
  withdrawTicketController,
  voidTicketController,
  restoreTicketController,
} from "./tickets.controller.js";

export const ticketsRouter = Router();

ticketsRouter.use(requireAuthentication);

ticketsRouter.post(
  "/",
  requireCustomer,
  requireCsrfToken,
  createTicketController,
);

ticketsRouter.get("/", listTicketsController);

ticketsRouter.get("/:ticketId", getTicketController);

ticketsRouter.post(
  "/:ticketId/withdraw",
  requireCustomer,
  requireCsrfToken,
  withdrawTicketController,
);

ticketsRouter.post("/:ticketId/void", requireCsrfToken, voidTicketController);

ticketsRouter.post(
  "/:ticketId/restore",
  requireOrganizationAdmin,
  requireCsrfToken,
  restoreTicketController,
);

ticketsRouter.get("/:ticketId/internal-notes", listTicketNotesController);

ticketsRouter.post(
  "/:ticketId/internal-notes",
  requireCsrfToken,
  createTicketNoteController,
);

ticketsRouter.patch(
  "/:ticketId/internal-notes/:noteId",
  requireCsrfToken,
  editTicketNoteController,
);

ticketsRouter.patch(
  "/:ticketId/priority",
  requireCsrfToken,
  updateTicketPriorityController,
);

ticketsRouter.patch(
  "/:ticketId/status",
  requireCsrfToken,
  updateTicketStatusController,
);

ticketsRouter.post(
  "/:ticketId/claim",
  requireAgent,
  requireCsrfToken,
  claimTicketController,
);

ticketsRouter.post(
  "/:ticketId/release",
  requireAgent,
  requireCsrfToken,
  releaseTicketController,
);

ticketsRouter.put(
  "/:ticketId/assignment",
  requireOrganizationAdmin,
  requireCsrfToken,
  updateTicketAssignmentController,
);

ticketsRouter.post(
  "/:ticketId/messages",
  requireCsrfToken,
  addTicketMessageController,
);
