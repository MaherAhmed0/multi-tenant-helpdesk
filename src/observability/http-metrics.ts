import * as client from "@prometheus-io/client";

export const metricsRegistry = new client.Registry();

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total completed HTTP requests.",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route"] as const,
  registers: [metricsRegistry],
});
