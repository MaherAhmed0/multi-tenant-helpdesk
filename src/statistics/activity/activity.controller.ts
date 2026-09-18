import type { Request, Response } from "express";

import { AppError } from "../../errors/app-error.js";
import { activityQuerySchema } from "./activity.schema.js";
import { getStatisticsActivity } from "./activity.service.js";

export async function getStatisticsActivityController(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.auth) throw new Error("Authenticated request context is missing");
  const query = activityQuerySchema.safeParse(req.query);
  if (!query.success) {
    throw new AppError(400, "Invalid activity query", query.error.issues);
  }
  const { activity, cacheStatus } = await getStatisticsActivity(
    req.auth.organizationId,
    query.data.days,
  );
  res.set("X-Cache", cacheStatus);
  res.set("Cache-Control", "no-store");
  res.status(200).json(activity);
}
