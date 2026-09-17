import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { Request, RequestHandler, Response } from "express";

import { logger } from "./logger.js";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
} from "./http-metrics.js";
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

export function getNormalizedRequestRoute(req: Request, res: Response): string {
  const prefix =
    typeof res.locals.requestRoutePrefix === "string"
      ? res.locals.requestRoutePrefix
      : "";

  const routePath =
    typeof req.route?.path === "string" ? req.route.path : undefined;

  if (routePath) {
    if (routePath === "/") {
      return prefix || "/";
    }

    return `${prefix}${routePath}`;
  }

  if (prefix) {
    return prefix;
  }

  return "unmatched";
}

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
      const route = getNormalizedRequestRoute(req, res);
      const durationMs = performance.now() - startedAt;

      if (res.writableFinished) {
        httpRequestsTotal.inc({
          method: req.method,
          route,
          status: String(res.statusCode),
        });

        httpRequestDurationSeconds.observe(
          { method: req.method, route },
          durationMs / 1000,
        );
      }
      // EventEmitter callbacks may run outside the original async chain.
      // Re-enter this request's store, including any successful auth enrichment.
      runWithRequestContext(context, () =>
        logger.info({
          event: "http_request_completed",
          method: req.method,
          route,
          statusCode: res.statusCode,
          durationMs,
          ...(res.writableFinished ? {} : { aborted: true }),
        }),
      );
    };
    res.once("finish", completed);
    res.once("close", completed);
    next();
  });
};
