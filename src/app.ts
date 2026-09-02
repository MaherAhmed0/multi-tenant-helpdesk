import express from "express";

import { healthRouter } from "./health/health.routes.js";

export const app = express();

app.use("/health", healthRouter);
