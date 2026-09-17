import { setImmediate as tick } from "node:timers/promises";

import express from "express";
import request from "supertest";
import { afterAll, beforeEach, expect, it } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  metricsRegistry,
} from "./http-metrics.js";
import {
  captureRequestRoutePrefix,
  requestContextMiddleware,
} from "./request.middleware.js";

beforeEach(() => metricsRegistry.resetMetrics());
afterAll(async () => {
  await db.destroy();
});

it("counts each request once and observes duration using normalized route labels", async () => {
  const testApp = express();
  testApp.use(requestContextMiddleware);
  const router = express.Router();
  router.get("/:itemId", (_req, res) => {
    res.sendStatus(200);
  });
  testApp.use("/items", captureRequestRoutePrefix, router);

  await request(testApp)
    .get("/items/first-private-id?search=private-query")
    .expect(200);
  await tick();
  expect((await httpRequestsTotal.get()).values).toEqual([
    {
      value: 1,
      labels: { method: "GET", route: "/items/:itemId", status: "200" },
    },
  ]);
  const histogram = await httpRequestDurationSeconds.get();
  expect(
    histogram.values.find(
      (value) => value.metricName === "http_request_duration_seconds_count",
    ),
  ).toEqual({
    metricName: "http_request_duration_seconds_count",
    value: 1,
    labels: { method: "GET", route: "/items/:itemId" },
  });
  expect(
    histogram.values.find(
      (value) => value.metricName === "http_request_duration_seconds_sum",
    )!.value,
  ).toBeGreaterThanOrEqual(0);

  await request(testApp).get("/items/second-private-id").expect(200);
  await tick();
  expect((await httpRequestsTotal.get()).values).toEqual([
    {
      value: 2,
      labels: { method: "GET", route: "/items/:itemId", status: "200" },
    },
  ]);
  expect(await metricsRegistry.metrics()).not.toContain("private");
});

it("exposes the two HTTP metric families at GET /metrics with Prometheus content type", async () => {
  await request(app).get("/health").expect(200);
  const response = await request(app).get("/metrics").expect(200);
  expect(response.headers["content-type"]?.split("; ").sort()).toEqual(
    metricsRegistry.contentType.split("; ").sort(),
  );
  expect(response.text).toContain("# TYPE http_requests_total counter");
  expect(response.text).toContain(
    'http_requests_total{method="GET",route="/health",status="200"} 1',
  );
  expect(response.text).toContain(
    "# TYPE http_request_duration_seconds histogram",
  );
  expect(response.text).toContain(
    'http_request_duration_seconds_count{method="GET",route="/health"} 1',
  );
  expect(
    (await metricsRegistry.getMetricsAsJSON())
      .map((metric) => metric.name)
      .sort(),
  ).toEqual(["http_request_duration_seconds", "http_requests_total"]);
});
