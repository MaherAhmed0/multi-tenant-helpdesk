import { Router } from "express";

import { requireAuthentication } from "./auth.middleware.js";
import { loginController } from "./login.controller.js";
import { getMeController } from "./me.controller.js";
import { logoutController } from "./logout.controller.js";

export const authRouter = Router();

authRouter.post("/login", loginController);

authRouter.get("/me", requireAuthentication, getMeController);

authRouter.post("/logout", requireAuthentication, logoutController);
