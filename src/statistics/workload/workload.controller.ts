import type { Request, Response } from "express";

import { getStatisticsWorkload } from "./workload.service.js";

export async function getStatisticsWorkloadController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const { workload, cacheStatus } = await getStatisticsWorkload(
    req.auth.organizationId,
  );
  res.set("Cache-Control", "no-store");
  res.set("X-Cache", cacheStatus);
  res.status(200).json(workload);
}
