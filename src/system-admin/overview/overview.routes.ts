import { Router } from "express";

import { requireSystemAdminAuthentication } from "../auth.middleware.js";
import { getPlatformOverviewController } from "./overview.controller.js";

export const systemAdminOverviewRouter = Router();

systemAdminOverviewRouter.use(requireSystemAdminAuthentication);
systemAdminOverviewRouter.get("/", getPlatformOverviewController);
