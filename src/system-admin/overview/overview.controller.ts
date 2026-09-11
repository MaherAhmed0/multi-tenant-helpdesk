import type { Request, Response } from "express";

import { getPlatformOverview } from "./overview.service.js";

export async function getPlatformOverviewController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.systemAdminAuth)
    throw new Error("Authenticated SYSTEM_ADMIN request context is missing");
  const overview = await getPlatformOverview();
  res.set("Cache-Control", "no-store");
  res.status(200).json(overview);
}
