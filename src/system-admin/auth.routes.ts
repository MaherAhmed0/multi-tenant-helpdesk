import { Router } from "express";

import { systemAdminLoginController } from "./login.controller.js";
import { systemAdminMfaController } from "./mfa.controller.js";

export const systemAdminAuthRouter = Router();

systemAdminAuthRouter.post("/login", systemAdminLoginController);
systemAdminAuthRouter.post("/mfa", systemAdminMfaController);
