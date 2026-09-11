import type { Request, Response } from "express";

import { AppError } from "../../errors/app-error.js";
import { tenantUserParamsSchema } from "./tenant-users.schema.js";
import {
  deactivateTenantUser,
  reactivateTenantUser,
  revokeTenantUserSessions,
} from "./tenant-users.service.js";

export async function deactivateTenantUserController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = tenantUserParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid tenant user ID", result.error.issues);
  await deactivateTenantUser(result.data.userId);
  res.status(204).send();
}

export async function reactivateTenantUserController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = tenantUserParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid tenant user ID", result.error.issues);
  await reactivateTenantUser(result.data.userId);
  res.status(204).send();
}

export async function revokeTenantUserSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const result = tenantUserParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid tenant user ID", result.error.issues);
  await revokeTenantUserSessions(result.data.userId);
  res.status(204).send();
}
