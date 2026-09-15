import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireCustomer } from "../auth/customer.middleware.js";
import { requireAgent } from "../auth/agent.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  createTicketController,
  getTicketController,
  listTicketsController,
  addCustomerMessageController,
  claimTicketController,
  releaseTicketController,
  updateTicketAssignmentController,
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
  requireCustomer,
  requireCsrfToken,
  addCustomerMessageController,
);
