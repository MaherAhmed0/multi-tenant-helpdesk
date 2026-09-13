import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  getAgentController,
  listAgentsController,
  reassignAgentTeamController,
  deactivateAgentController,
  reactivateAgentController,
  revokeAgentSessionsController,
} from "./agents.controller.js";

export const agentsRouter = Router();

agentsRouter.use(requireAuthentication, requireOrganizationAdmin);
agentsRouter.get("/", listAgentsController);
agentsRouter.get("/:agentId", getAgentController);
agentsRouter.put(
  "/:agentId/team",
  requireCsrfToken,
  reassignAgentTeamController,
);
agentsRouter.post(
  "/:agentId/deactivate",
  requireCsrfToken,
  deactivateAgentController,
);
agentsRouter.post(
  "/:agentId/reactivate",
  requireCsrfToken,
  reactivateAgentController,
);
agentsRouter.post(
  "/:agentId/revoke-sessions",
  requireCsrfToken,
  revokeAgentSessionsController,
);
