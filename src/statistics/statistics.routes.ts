import { Router } from "express";

import { requireAuthentication } from "../auth/auth.middleware.js";
import { requireOrganizationAdmin } from "../auth/organization-admin.middleware.js";
import { getStatisticsOverviewController } from "./overview/overview.controller.js";
import { getStatisticsWorkloadController } from "./workload/workload.controller.js";
import { getStatisticsActivityController } from "./activity/activity.controller.js";

export const statisticsRouter = Router();

statisticsRouter.use(requireAuthentication, requireOrganizationAdmin);
statisticsRouter.get("/overview", getStatisticsOverviewController);
statisticsRouter.get("/workload", getStatisticsWorkloadController);
statisticsRouter.get("/activity", getStatisticsActivityController);
