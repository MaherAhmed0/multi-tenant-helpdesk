import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  createAdminInvitationController,
  listAdminInvitationsController,
  revokeAdminInvitationController,
} from "./invitations.controller.js";

export const organizationAdminInvitationsRouter = Router();

organizationAdminInvitationsRouter.use(
  requireAuthentication,
  requireOrganizationAdmin,
);
organizationAdminInvitationsRouter.get("/", listAdminInvitationsController);
organizationAdminInvitationsRouter.post(
  "/",
  requireCsrfToken,
  createAdminInvitationController,
);
organizationAdminInvitationsRouter.post(
  "/:invitationId/revoke",
  requireCsrfToken,
  revokeAdminInvitationController,
);
