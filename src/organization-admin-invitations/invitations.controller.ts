import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  createInvitationSchema,
  invitationListSchema,
  invitationParamsSchema,
} from "./invitations.schema.js";
import {
  createAdminInvitation,
  listAdminInvitations,
  revokeAdminInvitation,
} from "./invitations.service.js";

export async function listAdminInvitationsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const query = invitationListSchema.safeParse(req.query);
  if (!query.success)
    throw new AppError(400, "Invalid invitation query", query.error.issues);
  const result = await listAdminInvitations(
    req.auth.organizationId,
    query.data,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(result);
}

export async function createAdminInvitationController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const body = createInvitationSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid invitation data", body.error.issues);
  const result = await createAdminInvitation(
    req.auth.organizationId,
    body.data,
  );
  res.set("Cache-Control", "no-store");
  res.status(201).json(result);
}

export async function revokeAdminInvitationController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = invitationParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid invitation ID", params.error.issues);
  const result = await revokeAdminInvitation(
    req.auth.organizationId,
    params.data.invitationId,
  );
  res.set("Cache-Control", "no-store");
  res.status(200).json(result);
}
