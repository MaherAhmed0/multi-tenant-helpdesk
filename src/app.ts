import express from "express";

import { healthRouter } from "./health/health.routes.js";
import { registrationRouter } from "./organization-registration/registration.routes.js";
import { errorMiddleware } from "./errors/error.middleware.js";
import { authRouter } from "./auth/auth.routes.js";
import { teamsRouter } from "./teams/teams.routes.js";
import { agentsRouter } from "./agents/agents.routes.js";
import { systemAdminAuthRouter } from "./system-admin/auth.routes.js";
import { systemAdminOrganizationsRouter } from "./system-admin/organizations/organizations.routes.js";
import { systemAdminOverviewRouter } from "./system-admin/overview/overview.routes.js";
import { systemAdminTenantUsersRouter } from "./system-admin/tenant-users/tenant-users.routes.js";
import cookieParser from "cookie-parser";

export const app = express();

app.use(express.json());
app.use(cookieParser());

app.use("/health", healthRouter);
app.use("/organization-registration", registrationRouter);
app.use("/auth", authRouter);
app.use("/teams", teamsRouter);
app.use("/agents", agentsRouter);
app.use("/system-admin/auth", systemAdminAuthRouter);
app.use("/system-admin/organizations", systemAdminOrganizationsRouter);
app.use("/system-admin/overview", systemAdminOverviewRouter);
app.use("/system-admin/tenant-users", systemAdminTenantUsersRouter);

app.use(errorMiddleware);
