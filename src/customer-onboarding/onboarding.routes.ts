import { Router } from "express";

import { requireLoginClient } from "../auth/csrf/csrf.middleware.js";
import { customerLoginController } from "./customer-login.controller.js";

import {
  getPublicOrganizationController,
  registerCustomerController,
} from "./onboarding.controller.js";

export const customerOnboardingRouter = Router();

customerOnboardingRouter.get("/:slug", getPublicOrganizationController);
customerOnboardingRouter.post(
  "/:slug/customers/register",
  registerCustomerController,
);
customerOnboardingRouter.post(
  "/:slug/customers/login",
  requireLoginClient,
  customerLoginController,
);
