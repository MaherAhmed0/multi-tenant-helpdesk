import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RequestHandler } from "express";

import { logger } from "./logger.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "./request-context.js";

// Used only at the application's static router mounts. Express restores baseUrl
// when propagating errors, so remember it before entering the mounted router.
export const captureRequestRoutePrefix: RequestHandler = (req, res, next) => {
  res.locals.requestRoutePrefix = req.baseUrl;
  next();
};

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const context: RequestContext = { requestId: randomUUID() };
  const startedAt = performance.now();
  res.setHeader("X-Request-Id", context.requestId);

  runWithRequestContext(context, () => {
    let logged = false;
    const completed = () => {
      if (logged) return;
      logged = true;
      res.off("finish", completed);
      res.off("close", completed);
      const path: unknown = req.route?.path;
      const prefix: unknown = res.locals.requestRoutePrefix;
      const route =
        typeof path === "string"
          ? `${typeof prefix === "string" ? prefix : ""}${path === "/" && prefix ? "" : path}`
          : "unmatched";
      // EventEmitter callbacks may run outside the original async chain.
      // Re-enter this request's store, including any successful auth enrichment.
      runWithRequestContext(context, () =>
        logger.info({
          event: "http_request_completed",
          method: req.method,
          route,
          statusCode: res.statusCode,
          durationMs: performance.now() - startedAt,
          ...(res.writableFinished ? {} : { aborted: true }),
        }),
      );
    };
    res.once("finish", completed);
    res.once("close", completed);
    next();
  });
};
