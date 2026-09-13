import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { requireCsrfToken } from "../auth/csrf/csrf.middleware.js";
import {
  createTeamController,
  getTeamController,
  listTeamsController,
  renameTeamController,
  deactivateTeamController,
  reactivateTeamController,
} from "./teams.controller.js";

export const teamsRouter = Router();

teamsRouter.use(requireAuthentication, requireOrganizationAdmin);
teamsRouter.get("/", listTeamsController);
teamsRouter.get("/:teamId", getTeamController);
teamsRouter.post("/", requireCsrfToken, createTeamController);
teamsRouter.patch("/:teamId", requireCsrfToken, renameTeamController);
teamsRouter.post(
  "/:teamId/deactivate",
  requireCsrfToken,
  deactivateTeamController,
);
teamsRouter.post(
  "/:teamId/reactivate",
  requireCsrfToken,
  reactivateTeamController,
);
