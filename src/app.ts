import express from "express";

import { healthRouter } from "./health/health.routes.js";
import { registrationRouter } from "./organization-registration/registration.routes.js";
import { errorMiddleware } from "./errors/error.middleware.js";
import { authRouter } from "./auth/auth.routes.js";
import { teamsRouter } from "./teams/teams.routes.js";
import { agentsRouter } from "./agents/agents.routes.js";
import { agentInvitationsRouter } from "./agent-invitations/invitations.routes.js";
import { organizationAdminInvitationsRouter } from "./organization-admin-invitations/invitations.routes.js";
import { invitationsRouter } from "./invitations/invitations.routes.js";
import { customerOnboardingRouter } from "./customer-onboarding/onboarding.routes.js";
import { ticketsRouter } from "./tickets/tickets.routes.js";
import { systemAdminAuthRouter } from "./system-admin/auth.routes.js";
import { systemAdminOrganizationsRouter } from "./system-admin/organizations/organizations.routes.js";
import { systemAdminOverviewRouter } from "./system-admin/overview/overview.routes.js";
import { systemAdminTenantUsersRouter } from "./system-admin/tenant-users/tenant-users.routes.js";
import cookieParser from "cookie-parser";
import {
  requestContextMiddleware,
  captureRequestRoutePrefix,
} from "./observability/request.middleware.js";

export const app = express();

app.use(requestContextMiddleware);
app.use(express.json());
app.use(cookieParser());

app.use("/health", captureRequestRoutePrefix, healthRouter);
app.use(
  "/organization-registration",
  captureRequestRoutePrefix,
  registrationRouter,
);
app.use("/auth", captureRequestRoutePrefix, authRouter);
app.use("/teams", captureRequestRoutePrefix, teamsRouter);
app.use("/agents", captureRequestRoutePrefix, agentsRouter);
app.use(
  "/agent-invitations",
  captureRequestRoutePrefix,
  agentInvitationsRouter,
);
app.use(
  "/organization-admin-invitations",
  captureRequestRoutePrefix,
  organizationAdminInvitationsRouter,
);
app.use("/invitations", captureRequestRoutePrefix, invitationsRouter);
app.use(
  "/public/organizations",
  captureRequestRoutePrefix,
  customerOnboardingRouter,
);
app.use("/tickets", captureRequestRoutePrefix, ticketsRouter);
app.use("/system-admin/auth", captureRequestRoutePrefix, systemAdminAuthRouter);
app.use(
  "/system-admin/organizations",
  captureRequestRoutePrefix,
  systemAdminOrganizationsRouter,
);
app.use(
  "/system-admin/overview",
  captureRequestRoutePrefix,
  systemAdminOverviewRouter,
);
app.use(
  "/system-admin/tenant-users",
  captureRequestRoutePrefix,
  systemAdminTenantUsersRouter,
);

app.use(errorMiddleware);
