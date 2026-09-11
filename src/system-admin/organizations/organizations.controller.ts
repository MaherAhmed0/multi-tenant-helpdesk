import type { Request, Response } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  organizationListSchema,
  organizationParamsSchema,
} from "./organizations.schema.js";
import {
  getOrganization,
  getOrganizationAdmins,
  listOrganizations,
  deactivateOrganization,
  reactivateOrganization,
  revokeOrganizationSessions,
} from "./organizations.service.js";

export async function deactivateOrganizationController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid organization ID", result.error.issues);
  await deactivateOrganization(result.data.organizationId);
  res.status(204).send();
}

export async function reactivateOrganizationController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid organization ID", result.error.issues);
  await reactivateOrganization(result.data.organizationId);
  res.status(204).send();
}

export async function revokeOrganizationSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid organization ID", result.error.issues);
  await revokeOrganizationSessions(result.data.organizationId);
  res.status(204).send();
}

export async function listOrganizationsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationListSchema.safeParse(req.query);
  if (!result.success)
    throw new AppError(400, "Invalid organization query", result.error.issues);
  const organizations = await listOrganizations(result.data);
  res.set("Cache-Control", "no-store");
  res.status(200).json(organizations);
}

export async function getOrganizationController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid organization ID", result.error.issues);
  const organization = await getOrganization(result.data.organizationId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(organization);
}

export async function getOrganizationAdminsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = organizationParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid organization ID", result.error.issues);
  const admins = await getOrganizationAdmins(result.data.organizationId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(admins);
}
