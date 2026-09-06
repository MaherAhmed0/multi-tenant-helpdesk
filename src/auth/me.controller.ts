import type { Request, Response } from "express";

export function getMeController(req: Request, res: Response): void {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  res.status(200).json({
    user: {
      id: req.auth.userId,
      organizationId: req.auth.organizationId,
      role: req.auth.role,
    },
    session: {
      id: req.auth.sessionId,
    },
  });
}
