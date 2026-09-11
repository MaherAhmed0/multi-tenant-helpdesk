import { Router } from "express";

import { requireSystemAdminAuthentication } from "../auth.middleware.js";
import {
  deactivateTenantUserController,
  reactivateTenantUserController,
  revokeTenantUserSessionsController,
} from "./tenant-users.controller.js";

export const systemAdminTenantUsersRouter = Router();

systemAdminTenantUsersRouter.use(requireSystemAdminAuthentication);
systemAdminTenantUsersRouter.post("/:userId/deactivate", deactivateTenantUserController);
systemAdminTenantUsersRouter.post("/:userId/reactivate", reactivateTenantUserController);
systemAdminTenantUsersRouter.post("/:userId/revoke-sessions", revokeTenantUserSessionsController);
