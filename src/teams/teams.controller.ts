import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  teamListSchema,
  teamNameSchema,
  teamParamsSchema,
} from "./teams.schema.js";
import {
  createTeam,
  getTeam,
  listTeams,
  renameTeam,
  deactivateTeam,
  reactivateTeam,
} from "./teams.service.js";

export async function listTeamsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const result = teamListSchema.safeParse(req.query);
  if (!result.success)
    throw new AppError(400, "Invalid team query", result.error.issues);
  const teams = await listTeams(req.auth.organizationId, result.data);
  res.set("Cache-Control", "no-store");
  res.status(200).json(teams);
}

export async function getTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const result = teamParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid team ID", result.error.issues);
  const team = await getTeam(req.auth.organizationId, result.data.teamId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(team);
}

export async function createTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const result = teamNameSchema.safeParse(req.body);
  if (!result.success)
    throw new AppError(400, "Invalid team data", result.error.issues);
  const team = await createTeam(req.auth.organizationId, result.data.name);
  res.status(201).json(team);
}

export async function renameTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = teamParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid team ID", params.error.issues);
  const body = teamNameSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid team data", body.error.issues);
  const team = await renameTeam(
    req.auth.organizationId,
    params.data.teamId,
    body.data.name,
  );
  res.status(200).json(team);
}

export async function deactivateTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = teamParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid team ID", params.error.issues);
  const team = await deactivateTeam(
    req.auth.organizationId,
    params.data.teamId,
  );
  res.status(200).json(team);
}

export async function reactivateTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = teamParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid team ID", params.error.issues);
  const team = await reactivateTeam(
    req.auth.organizationId,
    params.data.teamId,
  );
  res.status(200).json(team);
}
