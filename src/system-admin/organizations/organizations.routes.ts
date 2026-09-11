import { Router } from "express";

import { requireSystemAdminAuthentication } from "../auth.middleware.js";
import {
  deactivateOrganizationController,
  reactivateOrganizationController,
  revokeOrganizationSessionsController,
  getOrganizationAdminsController,
  getOrganizationController,
  listOrganizationsController,
} from "./organizations.controller.js";

export const systemAdminOrganizationsRouter = Router();

systemAdminOrganizationsRouter.use(requireSystemAdminAuthentication);
systemAdminOrganizationsRouter.post(
  "/:organizationId/deactivate",
  deactivateOrganizationController,
);
systemAdminOrganizationsRouter.post(
  "/:organizationId/reactivate",
  reactivateOrganizationController,
);
systemAdminOrganizationsRouter.post(
  "/:organizationId/revoke-sessions",
  revokeOrganizationSessionsController,
);
systemAdminOrganizationsRouter.get("/", listOrganizationsController);
systemAdminOrganizationsRouter.get(
  "/:organizationId",
  getOrganizationController,
);
systemAdminOrganizationsRouter.get(
  "/:organizationId/admins",
  getOrganizationAdminsController,
);
