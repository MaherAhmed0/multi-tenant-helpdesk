import { Router } from "express";

import { systemAdminLoginController } from "./login/login.controller.js";
import { systemAdminMfaController } from "./mfa/mfa.controller.js";
import { systemAdminRecoveryController } from "./recovery/recovery.controller.js";
import { requireSystemAdminAuthentication } from "./auth.middleware.js";
import { getSystemAdminMeController } from "./me.controller.js";
import {
  logoutSystemAdminController,
  listSystemAdminSessionsController,
  revokeSystemAdminSessionController,
  logoutAllSystemAdminSessionsController,
} from "./sessions/session-management.controller.js";

export const systemAdminAuthRouter = Router();

systemAdminAuthRouter.post("/login", systemAdminLoginController);

systemAdminAuthRouter.post("/mfa", systemAdminMfaController);

systemAdminAuthRouter.post("/recovery", systemAdminRecoveryController);

systemAdminAuthRouter.get(
  "/me",
  requireSystemAdminAuthentication,
  getSystemAdminMeController,
);

systemAdminAuthRouter.post(
  "/logout",
  requireSystemAdminAuthentication,
  logoutSystemAdminController,
);

systemAdminAuthRouter.get(
  "/sessions",
  requireSystemAdminAuthentication,
  listSystemAdminSessionsController,
);

systemAdminAuthRouter.delete(
  "/sessions/:id",
  requireSystemAdminAuthentication,
  revokeSystemAdminSessionController,
);

systemAdminAuthRouter.post(
  "/logout-all",
  requireSystemAdminAuthentication,
  logoutAllSystemAdminSessionsController,
);
