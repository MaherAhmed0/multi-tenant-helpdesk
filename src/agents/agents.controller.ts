import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import {
  agentListSchema,
  agentParamsSchema,
  agentTeamSchema,
} from "./agents.schema.js";
import {
  getAgent,
  listAgents,
  reassignAgentTeam,
  deactivateAgent,
  reactivateAgent,
  revokeAgentSessions,
} from "./agents.service.js";

export async function listAgentsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const result = agentListSchema.safeParse(req.query);
  if (!result.success)
    throw new AppError(400, "Invalid agent query", result.error.issues);
  const agents = await listAgents(req.auth.organizationId, result.data);
  res.set("Cache-Control", "no-store");
  res.status(200).json(agents);
}

export async function getAgentController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const result = agentParamsSchema.safeParse(req.params);
  if (!result.success)
    throw new AppError(400, "Invalid agent ID", result.error.issues);
  const agent = await getAgent(req.auth.organizationId, result.data.agentId);
  res.set("Cache-Control", "no-store");
  res.status(200).json(agent);
}

export async function reassignAgentTeamController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = agentParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid agent ID", params.error.issues);
  const body = agentTeamSchema.safeParse(req.body);
  if (!body.success)
    throw new AppError(400, "Invalid agent team data", body.error.issues);
  const agent = await reassignAgentTeam(
    req.auth.organizationId,
    params.data.agentId,
    body.data.teamId,
  );
  res.status(200).json(agent);
}

export async function deactivateAgentController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = agentParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid agent ID", params.error.issues);
  const agent = await deactivateAgent(
    req.auth.organizationId,
    params.data.agentId,
  );
  res.status(200).json(agent);
}

export async function reactivateAgentController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = agentParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid agent ID", params.error.issues);
  const agent = await reactivateAgent(
    req.auth.organizationId,
    params.data.agentId,
  );
  res.status(200).json(agent);
}

export async function revokeAgentSessionsController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const params = agentParamsSchema.safeParse(req.params);
  if (!params.success)
    throw new AppError(400, "Invalid agent ID", params.error.issues);
  await revokeAgentSessions(req.auth.organizationId, params.data.agentId);
  res.status(204).send();
}
