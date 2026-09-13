import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { acceptanceSchema } from "./acceptance.schema.js";
import { acceptInvitation } from "./acceptance.service.js";

export async function acceptInvitationController(
  req: Request,
  res: Response,
): Promise<void> {
  res.set("Cache-Control", "no-store");
  const body = acceptanceSchema.safeParse(req.body);
  // Do not echo credential input or arbitrary client-supplied keys in validation details.
  if (!body.success)
    throw new AppError(400, "Invalid invitation acceptance data");
  const user = await acceptInvitation(body.data);
  res.status(201).json(user);
}
