import { Router } from "express";

import { metricsRegistry } from "./http-metrics.js";

export const metricsRouter = Router();

metricsRouter.get("/", async (_req, res) => {
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});
