import type { ErrorRequestHandler } from "express";

import { AppError } from "./app-error.js";

export const errorMiddleware: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
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

  console.error(error);

  res.status(500).json({
    error: "Internal server error",
  });
};
