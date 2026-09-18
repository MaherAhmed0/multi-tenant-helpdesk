import type { Request, Response } from "express";

import { getStatisticsOverview } from "./overview.service.js";

export async function getStatisticsOverviewController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const { overview, cacheStatus } = await getStatisticsOverview(
    req.auth.organizationId,
  );
  res.set("Cache-Control", "no-store");
  res.set("X-Cache", cacheStatus);
  res.status(200).json(overview);
}
