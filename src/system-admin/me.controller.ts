import type { Request, Response } from "express";

export function getSystemAdminMeController(req: Request, res: Response): void {
  if (!req.systemAdminAuth) {
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  }

  res.set("Cache-Control", "no-store");
  res.status(200).json({
    id: req.systemAdminAuth.systemAdminId,
    email: req.systemAdminAuth.email,
  });
}
