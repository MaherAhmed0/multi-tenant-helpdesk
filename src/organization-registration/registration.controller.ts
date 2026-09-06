import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { registrationSchema } from "./registration.schema.js";
import { registerOrganization as registerOrganizationService } from "./registration.service.js";

export async function registerOrganization(
  req: Request,
  res: Response,
): Promise<void> {
  const result = registrationSchema.safeParse(req.body);

  if (!result.success) {
    throw new AppError(400, "Invalid registration data", result.error.issues);
  }

  const registration = await registerOrganizationService(result.data);

  res.status(201).json(registration);
}
