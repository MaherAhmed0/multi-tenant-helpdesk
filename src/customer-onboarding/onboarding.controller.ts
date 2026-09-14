import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  customerRegistrationSchema,
  publicOrganizationParamsSchema,
} from "./onboarding.schema.js";
import {
  getPublicOrganization,
  registerCustomer,
} from "./onboarding.service.js";

export async function getPublicOrganizationController(
  req: Request,
  res: Response,
): Promise<void> {
  res.set("Cache-Control", "no-store");
  const params = publicOrganizationParamsSchema.safeParse(req.params);
  if (!params.success) throw new AppError(400, "Invalid organization slug");
  const organization = await getPublicOrganization(params.data.slug);
  res.status(200).json(organization);
}

export async function registerCustomerController(
  req: Request,
  res: Response,
): Promise<void> {
  res.set("Cache-Control", "no-store");
  const params = publicOrganizationParamsSchema.safeParse(req.params);
  if (!params.success) throw new AppError(400, "Invalid organization slug");
  const body = customerRegistrationSchema.safeParse(req.body);
  // Credential validation errors must not echo the submitted password.
  if (!body.success)
    throw new AppError(400, "Invalid customer registration data");
  const customer = await registerCustomer(params.data.slug, body.data);
  res.status(201).json(customer);
}
