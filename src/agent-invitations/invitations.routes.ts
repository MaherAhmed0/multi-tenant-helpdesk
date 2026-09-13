import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  createInvitationController,
  listInvitationsController,
  revokeInvitationController,
} from "./invitations.controller.js";

export const agentInvitationsRouter = Router();

agentInvitationsRouter.use(requireAuthentication, requireOrganizationAdmin);
agentInvitationsRouter.get("/", listInvitationsController);
agentInvitationsRouter.post("/", requireCsrfToken, createInvitationController);
agentInvitationsRouter.post(
  "/:invitationId/revoke",
  requireCsrfToken,
  revokeInvitationController,
);
