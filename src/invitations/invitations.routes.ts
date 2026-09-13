import { Router } from "express";

import { acceptInvitationController } from "./acceptance.controller.js";

export const invitationsRouter = Router();

invitationsRouter.post("/accept", acceptInvitationController);
