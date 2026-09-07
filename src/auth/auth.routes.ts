import { Router } from "express";

import { requireAuthentication } from "./auth.middleware.js";
import { loginController } from "./login.controller.js";
import { getMeController } from "./me.controller.js";
import { logoutController } from "./logout.controller.js";
import { getCsrfController } from "./csrf.controller.js";
import { requireCsrfToken, requireLoginClient } from "./csrf.middleware.js";
import {
  listSessionsController,
  revokeSessionController,
  logoutAllController,
} from "./session-management.controller.js";

export const authRouter = Router();

authRouter.post("/login", requireLoginClient, loginController);

authRouter.get("/me", requireAuthentication, getMeController);

authRouter.get("/csrf", requireAuthentication, getCsrfController);

authRouter.post(
  "/logout",
  requireAuthentication,
  requireCsrfToken,
  logoutController,
);

authRouter.get("/sessions", requireAuthentication, listSessionsController);

authRouter.delete(
  "/sessions/:sessionId",
  requireAuthentication,
  requireCsrfToken,
  revokeSessionController,
);

authRouter.post(
  "/logout-all",
  requireAuthentication,
  requireCsrfToken,
  logoutAllController,
);
