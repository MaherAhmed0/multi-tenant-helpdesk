import { Router } from "express";

import { registerOrganization } from "./registration.controller.js";

export const registrationRouter = Router();

registrationRouter.post("/", registerOrganization);
