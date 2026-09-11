import type { Request, Response } from "express";

import { deriveCsrfToken } from "./csrf-token.js";

export function getCsrfController(req: Request, res: Response): void {
  if (!req.auth) {
    throw new Error("Authenticated request context is missing");
  }

  res.set("Cache-Control", "no-store");
  res.status(200).json({ csrfToken: deriveCsrfToken(req.auth.sessionId) });
}
