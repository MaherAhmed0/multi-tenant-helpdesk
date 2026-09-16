import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";

import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { errorMiddleware } from "../errors/error.middleware.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../auth/sessions/session-token.js";
import { createSystemAdmin } from "../system-admin/system-admin.repository.js";
import { createSystemAdminSession } from "../system-admin/sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../system-admin/sessions/session-token.js";
import * as adminSessions from "../system-admin/sessions/session.repository.js";
import { createLogger, logger } from "./logger.js";
import {
  getRequestContext,
  runWithRequestContext,
  setRequestActor,
} from "./request-context.js";
import {
  captureRequestRoutePrefix,
  requestContextMiddleware,
} from "./request.middleware.js";

let records: Array<Record<string, unknown>>;
beforeEach(() => {
  records = [];
  const captured = createLogger({
    write: (line) => {
      records.push(JSON.parse(line));
    },
  });
  vi.spyOn(logger, "info").mockImplementation(captured.info.bind(captured));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.destroy();
});

async function tenantSession() {
  const org = await createOrganization(db, {
    name: "Observability",
    slug: `observability-${randomUUID()}`,
  });
  const user = await createUser(db, {
    organizationId: org.id,
    name: "Customer",
    role: "CUSTOMER",
    email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash",
    teamId: null,
  });
  const token = generateSessionToken();
  await createSession(db, {
    organizationId: org.id,
    userId: user.id,
    tokenHash: hashSessionToken(token),
    userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + 3600000),
  });
  return { org, user, cookie: `session=${token}` };
}
async function adminSession() {
  const admin = await createSystemAdmin(db, {
    email: `observability-${randomUUID()}@example.com`,
    passwordHash: "test-only-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-tag",
  });
  const credential = generateSystemAdminSessionToken();
  await createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + 3600000),
  });
  return { admin, cookie: `system_admin_session=${credential.token}` };
}

describe("request observability", () => {
  it("generates distinct server IDs and logs public completion once without actor data or request input", async () => {
    const responses = await Promise.all(
      [0, 1].map(() =>
        request(app)
          .get("/health?token=SENSITIVE-QUERY")
          .set("X-Request-Id", "untrusted-request-id")
          .set("Cookie", "secret=SENSITIVE-COOKIE")
          .set("Authorization", "Bearer SENSITIVE-AUTHORIZATION")
          .expect(200),
      ),
    );
    await tick();
    const ids = responses.map((response) => response.headers["x-request-id"]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        event: "http_request_completed",
        method: "GET",
        route: "/health",
        statusCode: 200,
        durationMs: expect.any(Number),
        requestId: expect.any(String),
      });
      expect(ids).toContain(record.requestId);
      expect(record.durationMs as number).toBeGreaterThanOrEqual(0);
      for (const key of ["actorId", "actorRole", "organizationId", "aborted"])
        expect(record).not.toHaveProperty(key);
    }
    expect(JSON.stringify(records)).not.toContain("SENSITIVE");
    expect(JSON.stringify(records)).not.toContain("untrusted-request-id");
    expect(getRequestContext()).toBeUndefined();
  });

  it("keeps independent ALS stores through interleaved awaits and does not mutate them while logging", async () => {
    await Promise.all(
      ["first", "second"].map((requestId) =>
        runWithRequestContext({ requestId }, async () => {
          setRequestActor({
            actorId: `actor-${requestId}`,
            actorRole: "AGENT",
            organizationId: `org-${requestId}`,
          });
          await tick();
          logger.info({
            event: "async_test",
            extra: requestId,
            requestId: "spoofed",
          });
          await tick();
          expect(getRequestContext()).toEqual({
            requestId,
            actorId: `actor-${requestId}`,
            organizationId: `org-${requestId}`,
            actorRole: "AGENT",
          });
        }),
      ),
    );
    expect(records.map((row) => row.requestId).sort()).toEqual([
      "first",
      "second",
    ]);
    for (const record of records)
      expect(record.actorId).toBe(`actor-${record.requestId}`);
    expect(getRequestContext()).toBeUndefined();
    expect(() =>
      setRequestActor({ actorId: "outside", actorRole: "SYSTEM_ADMIN" }),
    ).not.toThrow();
    expect(() => logger.info({ event: "outside_request" })).not.toThrow();
    expect(records[2]).toMatchObject({ event: "outside_request" });
    expect(records[2]).not.toHaveProperty("requestId");
    expect(records[2]).not.toHaveProperty("actorId");
  });

  it("enriches tenant requests only from authenticated context and keeps concurrent public/admin requests separate", async () => {
    const tenant = await tenantSession();
    const privileged = await adminSession();
    const [tenantResponse, adminResponse, publicResponse] = await Promise.all([
      request(app)
        .get("/auth/me?organizationId=forged&actorId=forged")
        .set("Cookie", tenant.cookie)
        .set("X-Actor-Id", "forged")
        .expect(200),
      request(app)
        .get("/system-admin/auth/me?organizationId=forged")
        .set("Cookie", privileged.cookie)
        .expect(200),
      request(app).get("/health").expect(200),
    ]);
    const tenantLog = records.find(
      (row) => row.requestId === tenantResponse.headers["x-request-id"],
    )!;
    const adminLog = records.find(
      (row) => row.requestId === adminResponse.headers["x-request-id"],
    )!;
    const publicLog = records.find(
      (row) => row.requestId === publicResponse.headers["x-request-id"],
    )!;
    expect(tenantLog).toMatchObject({
      route: "/auth/me",
      organizationId: tenant.org.id,
      actorId: tenant.user.id,
      actorRole: "CUSTOMER",
    });
    expect(adminLog).toMatchObject({
      route: "/system-admin/auth/me",
      actorId: privileged.admin.id,
      actorRole: "SYSTEM_ADMIN",
    });
    expect(adminLog).not.toHaveProperty("organizationId");
    expect(publicLog).not.toHaveProperty("actorId");
    expect(publicLog).not.toHaveProperty("organizationId");
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).not.toHaveProperty("sessionId");
      expect(record).not.toHaveProperty("email");
    }
    expect(JSON.stringify(records)).not.toContain(tenant.cookie);
    expect(JSON.stringify(records)).not.toContain(privileged.cookie);
    expect(JSON.stringify(records)).not.toContain("forged");
  });

  it("does not enrich missing, invalid, or stale sessions and retains normalized error routes", async () => {
    const missing = await request(app).get("/auth/me").expect(401);
    expect(missing.body).toEqual({ error: "Authentication required" });
    await request(app)
      .get("/auth/me")
      .set("Cookie", "session=INVALID-SECRET")
      .expect(401);
    const privileged = await adminSession();
    vi.spyOn(
      adminSessions,
      "updateSystemAdminSessionActivity",
    ).mockResolvedValueOnce(undefined);
    await request(app)
      .get("/system-admin/auth/me")
      .set("Cookie", privileged.cookie)
      .expect(401);
    expect(records).toHaveLength(3);
    expect(records.map((row) => row.route)).toEqual([
      "/auth/me",
      "/auth/me",
      "/system-admin/auth/me",
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        statusCode: 401,
        requestId: expect.any(String),
      });
      expect(record).not.toHaveProperty("actorId");
      expect(record).not.toHaveProperty("organizationId");
    }
    expect(JSON.stringify(records)).not.toContain("INVALID-SECRET");
  });

  it("uses matched route templates through asynchronous handlers and controlled errors, with a safe unmatched fallback", async () => {
    const testApp = express();
    testApp.use(requestContextMiddleware);
    const router = express.Router();
    router.get("/items/:itemId", async (_req, res) => {
      const initial = getRequestContext();
      await tick();
      expect(getRequestContext()).toBe(initial);
      logger.info({ event: "handler_reached" });
      res.json({ requestId: initial!.requestId });
    });
    router.get("/fail/:itemId", async () => {
      await tick();
      throw new AppError(409, "Expected conflict");
    });
    testApp.use("/test", captureRequestRoutePrefix, router);
    testApp.use(errorMiddleware);
    const success = await request(testApp)
      .get("/test/items/PRIVATE-ID?code=PRIVATE-CODE")
      .expect(200);
    expect(success.body.requestId).toBe(success.headers["x-request-id"]);
    const failure = await request(testApp)
      .get("/test/fail/PRIVATE-ID?code=PRIVATE-CODE")
      .expect(409);
    expect(failure.body).toEqual({ error: "Expected conflict" });
    const unknown = await request(testApp)
      .get("/PRIVATE-UNKNOWN?code=PRIVATE-CODE")
      .expect(404);
    expect(unknown.headers["x-request-id"]).toBeTruthy();
    await tick();
    const completed = records.filter(
      (row) => row.event === "http_request_completed",
    );
    expect(completed).toHaveLength(3);
    expect(completed.map((row) => row.route)).toEqual([
      "/test/items/:itemId",
      "/test/fail/:itemId",
      "unmatched",
    ]);
    expect(records.filter((row) => row.event === "handler_reached")).toEqual([
      expect.objectContaining({ requestId: success.headers["x-request-id"] }),
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });

  it("establishes context before JSON parsing without changing global error responses", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send('{"password":')
      .expect(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      expect.objectContaining({
        requestId: response.headers["x-request-id"],
        route: "unmatched",
        statusCode: 500,
        event: "http_request_completed",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("password");
  });

  it("logs a premature response close once, marked aborted", async () => {
    const testApp = express();
    testApp.use(requestContextMiddleware);
    testApp.get("/abort", (_req, res) => {
      res.destroy();
    });
    await request(testApp)
      .get("/abort")
      .then(
        () => {
          throw new Error("Expected connection close");
        },
        () => {},
      );
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      event: "http_request_completed",
      route: "/abort",
      aborted: true,
    });
  });

  it("redacts obvious sensitive field names without polluting later log events", () => {
    logger.info({
      event: "redaction_test",
      password: "SECRET-VALUE",
      token: "SECRET-VALUE",
      csrfToken: "SECRET-VALUE",
      recoveryCodes: ["SECRET-VALUE"],
      cookies: { session: "SECRET-VALUE" },
      auth: { userId: "SECRET-VALUE" },
      body: { anything: "SECRET-VALUE" },
      nested: { password: "SECRET-VALUE" },
    });
    logger.info({ event: "clean_event" });
    expect(JSON.stringify(records)).not.toContain("SECRET-VALUE");
    expect(records[0]).toMatchObject({ event: "redaction_test", nested: {} });
    expect(records[1]).not.toHaveProperty("nested");
    expect(records[1]).not.toHaveProperty("password");
    runWithRequestContext({ requestId: "switch" }, () => {
      setRequestActor({
        actorId: "tenant",
        actorRole: "AGENT",
        organizationId: "organization",
      });
      setRequestActor({ actorId: "platform", actorRole: "SYSTEM_ADMIN" });
      expect(getRequestContext()).toEqual({
        requestId: "switch",
        actorId: "platform",
        actorRole: "SYSTEM_ADMIN",
      });
    });
  });
});
