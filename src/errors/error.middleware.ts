import type { ErrorRequestHandler } from "express";

import { AppError } from "./app-error.js";
import { logger } from "../observability/logger.js";
import { getNormalizedRequestRoute } from "../observability/request.middleware.js";

export const errorMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: error.message,
      details: error.details,
    });

    return;
  }

  logger.error({
    event: "unhandled_request_error",
    err: error,
    method: req.method,
    route: getNormalizedRequestRoute(req, res),
  });

  res.status(500).json({
    error: "Internal server error",
  });
};
